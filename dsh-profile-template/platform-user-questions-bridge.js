// platform-user-questions-bridge.js — the user-questions provider extension of
// the platform's permission bridge (add-user-questions, ADR-0012).
//
// Subclasses PermissionSdkServer (from ./platform-permission-bridge.js) so the
// composed child finally carries the `ctx.userQuestions` provider the standard
// preset's ask_user_question tool requires — the desktop TUI registers one
// client-side; the platform registers this one host-side, over the EXISTING
// wire directions (no reverse RPC):
//
//   1. `userQuestion/ask` NOTIFICATION (child → host): each ask is forwarded
//      with its session id, a fresh askId, and the question batch — the same
//      notify lane session.event rides, but a dedicated method that never
//      enters the persisted session log (the seam publishes no audit stream by
//      design).
//   2. `userQuestions/answer` REQUEST (host → child): resolves or cancels the
//      pending ask by askId. Unknown ids answer `{accepted: false}` — that IS
//      the first-wins semantics: a resolved ask is already gone from the table
//      and a late second submission changes nothing.
//
// Lifecycle: pending asks live in one map; a fallback timer (default 15 min,
// DSH_ASK_FALLBACK_MS) cancels an ask whose host never answered — the
// host-restart-with-live-child case, rare but the tool call must never wedge.
// Server shutdown unregisters the provider and rejects everything still
// pending, so a runtime restart surfaces as a tool error, never a hang.
//
// Overlay mechanics mirror the permission swap: user-questions.patch.yml
// (written by dsh-profile.js AFTER permissions.patch.yml) disables the
// `platform-permission-server` row and inserts this subclass under a fresh
// `platform-user-questions-server` row; layer order is fixed by dsh-bridge.js.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { PermissionSdkServer } from "./platform-permission-bridge.js";

// JsonRpcLineTransport lives in the SDK server package's own dependency
// closure — same re-anchoring as the preset/permission bridges.
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

const name = "platform-user-questions-server";
const inject = ["agents", "userQuestions"];
const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) });

// Backstop only: the host's wait windows (web: none by design, bots: 10 min)
// normally resolve or cancel every ask long before this fires.
const ASK_FALLBACK_MS = Number(process.env.DSH_ASK_FALLBACK_MS) || 15 * 60_000;

class UserQuestionsSdkServer extends PermissionSdkServer {
  // askId → {resolve, reject, timer}. One pending ask per session in practice
  // (a turn runs its tool calls serially); the map is keyed globally and the
  // payload carries the session, so nothing here needs session bookkeeping.
  pendingAsks = new Map();

  constructor(ctx, transportPeer, options) {
    super(ctx, transportPeer, options);
    // The seam's single provider slot, held for this child's whole lifetime.
    // dsh-base composes the user-questions service in every real profile, so
    // the inject above is satisfied; a future profile without it simply never
    // loads this plugin (and composes no ask tool either — consistent).
    this.disposers.push(
      ctx.userQuestions.registerProvider({
        ask: (request) => this.#bridgeAsk(request),
      }),
    );
    // Shutdown ladder: reject everything still pending AFTER the provider is
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

  // Provider body: park the ask, notify the host, wait. `agent` is the live
  // calling root agent (the seam already rejected owned children); its session
  // id is what the host routes on.
  #bridgeAsk(request) {
    const sessionId = request?.agent?.session?.id;
    if (sessionId === undefined) {
      return Promise.reject(
        new Error("user questions require a session-bound caller in the platform composition"),
      );
    }
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
        entry.reject(new Error("the user closed this question request"));
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
  const server = new UserQuestionsSdkServer(ctx, transportPeer, {
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

export { Config, UserQuestionsSdkServer, apply, inject, name };
