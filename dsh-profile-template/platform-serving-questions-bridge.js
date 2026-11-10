// platform-serving-questions-bridge.js — the user-questions face of the
// serving child's bridge chain (add-serving-ask-bridge D1).
//
// Subclasses NotifySdkServer (from ./platform-notify-bridge.js) so a deployed
// serving child's `ask_user_question` tool finally has an answerer. The cell
// world gets this from ./platform-user-questions-bridge.js (a PermissionSdkServer
// subclass — a chain the serving child does not carry), so the ask body is
// ported, not reinvented: park the ask, notify upward, answer on request,
// first-wins by table emptiness, fallback timer.
//
//   1. `userQuestion/ask` NOTIFICATION (child → host): each scoped
//      `user-questions/request` is forwarded with its session id, a fresh
//      askId, and the question batch — the host here is the agent-runner's
//      harness (the notification pump routes it to the turn's collector).
//   2. `userQuestions/answer` REQUEST (host → child): resolves or cancels the
//      pending ask by askId; unknown ids answer `{accepted: false}` — the
//      first-wins semantics (a resolved ask is gone from the table; a late
//      second submission changes nothing).
//
// The serving-side answerer the runner drives: a runner that did not opt into
// asks (no X-Serving-Ask) or cannot surface one (message/send, delegation,
// bots) immediately answers `{askId, cancelled: true}` — the tool then fails
// with the user-closed error naming the caller, never a hang, and the
// 15-minute fallback timer (DSH_ASK_FALLBACK_MS) stays the last-resort
// backstop for a runner that died mid-ask.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { NotifySdkServer } from "./platform-notify-bridge.js";

// JsonRpcLineTransport lives in the SDK server package's own dependency
// closure — same re-anchoring as every bridge in this chain.
const transport = await (async () => {
  const serverRequire = createRequire(
    import.meta.resolve("@deepseek-ai/dsh-sdk-jsonrpc-server"),
  );
  const protocolDir = join(
    serverRequire.resolve("@deepseek-ai/dsh-sdk-protocol/package.json"),
    "..",
  );
  return import(pathToFileURL(join(protocolDir, "lib", "index.js")));
})();
const { JsonRpcLineTransport } = transport;

const name = "platform-serving-questions-server";
const inject = ["agents", "userQuestions"];
const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) });

// Backstop only: the runner's ask window is the remaining turn budget (the
// a2a layer cancels at the deadline), so this fires only when the runner
// itself is gone.
const ASK_FALLBACK_MS = Number(process.env.DSH_ASK_FALLBACK_MS) || 15 * 60_000;

class ServingQuestionsSdkServer extends NotifySdkServer {
  // askId → {resolve, reject, timer}. One pending ask per session in practice
  // (a turn runs its tool calls serially); the map is keyed globally and the
  // payload carries the session, so nothing here needs session bookkeeping.
  pendingAsks = new Map();

  constructor(ctx, transportPeer, options) {
    super(ctx, transportPeer, options);
    // The seam moved from registerProvider to the scoped "user-questions/
    // request" waterfall (0.2.0 D7.5) — the same consumption shape the cell
    // bridge registers. A root-level listener sees every scoped ask, and the
    // serving child has exactly one answerer (this bridge).
    this.disposers.push(
      ctx.on("user-questions/request", (request, next) => this.#bridgeAsk(request, next)),
    );
    // Shutdown ladder: reject everything still pending AFTER the answerer is
    // unregistered, so a late answer RPC finds an empty table.
    this.disposers.push(() => this.#rejectAll("the agent runtime is shutting down"));
  }

  #rejectAll(message) {
    for (const [askId, entry] of this.pendingAsks) {
      clearTimeout(entry.timer);
      this.pendingAsks.delete(askId);
      entry.reject(new Error(message));
    }
  }

  // Answerer body: park the ask, notify the host, wait. `agent` is the live
  // calling root agent; its session id is what the runner's collector routes
  // on. A request without a session-bound caller is deferred down the
  // waterfall — the service's own no-answerer error then names the real
  // condition (NO_PROVIDER), not a bridge-shaped one.
  #bridgeAsk(request, next) {
    const sessionId = request?.agent?.session?.id;
    if (sessionId === undefined) return next();
    const askId = randomUUID();
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingAsks.delete(askId)) {
            reject(new Error("the ask window closed before the user answered"));
          }
        }, ASK_FALLBACK_MS),
      };
      entry.timer.unref?.();
      // The seam's abort signal (askTimed windows) must unpark the ask
      // promptly — the fallback timer alone would hold it for 15 minutes.
      entry.onAbort = () => {
        if (this.pendingAsks.delete(askId)) {
          clearTimeout(entry.timer);
          reject(request.signal?.reason ?? new Error("the ask was aborted"));
        }
      };
      request.signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.pendingAsks.set(askId, entry);
      this.transport.notify("userQuestion/ask", {
        sessionId: String(sessionId),
        askId,
        questions: request.questions,
      });
    });
  }

  async handleRequest(method, params) {
    if (method === "userQuestions/answer") {
      const askId = typeof params?.askId === "string" ? params.askId : "";
      const entry = this.pendingAsks.get(askId);
      if (entry === undefined) return { accepted: false, reason: "unknown or already-resolved ask" };
      this.pendingAsks.delete(askId);
      clearTimeout(entry.timer);
      if (params?.cancelled === true) {
        // The serving layer declines with a reason (caller cannot answer, ask
        // window closed) — surface it in the tool error instead of the generic
        // user-closed text; a plain cancel keeps the cell bridge's wording.
        entry.reject(new Error(
          typeof params?.reason === "string" && params.reason ? params.reason : "the user closed this question request",
        ));
      } else {
        entry.resolve({ answers: Array.isArray(params?.answers) ? params.answers : [] });
      }
      return { accepted: true };
    }
    return super.handleRequest(method, params);
  }
}

// Wiring identical to the parent bridges — the only change is the server
// class. Stdout stays reserved for protocol frames; shutdown exits 0.
function apply(ctx, config) {
  const resolvedConfig = config;
  const rootFiber = ctx.root.fiber;
  const input = config.input ?? process.stdin;
  const output = config.output ?? process.stdout;
  const exit = config.exit ?? ((code) => process.exit(code));
  const transportPeer = new JsonRpcLineTransport(input, output);
  const server = new ServingQuestionsSdkServer(ctx, transportPeer, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
  });
  let exitTask;
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transportPeer.flush())]);
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
      exit(0);
    })();
    return exitTask;
  };
  transportPeer.onRequest(async (method, params) => {
    const result = await server.handleRequest(method, params);
    if (method === "shutdown") {
      setImmediate(() => disposeAndExit());
    }
    return result;
  });
  ctx.effect(() => {
    transportPeer.start();
    return async () => {
      await server.shutdown();
      transportPeer.close();
    };
  }, "jsonrpc.serve");
}

export { Config, ServingQuestionsSdkServer, apply, inject, name };
