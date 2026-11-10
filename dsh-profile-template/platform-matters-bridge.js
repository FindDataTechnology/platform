// platform-matters-bridge.js — the facade reception's matter face
// (add-matter-threads D2).
//
// Subclasses ServingQuestionsSdkServer (from
// ./platform-serving-questions-bridge.js) to compose the matter trio
// (matter-tools.js) into a deployed child — ONLY the agent-runner's FACADE
// children get this row (compose.js writes matters.patch.yml when the
// descriptor carries a `facade` block); every other child keeps the
// questions row and never sees the tools.
//
// WHAT IT ADDS:
//   1. the model-facing matter_open / matter_status / matter_read tools,
//      whose calls ride `matterCall/send` notifications up to the runner;
//   2. the host's `matterCall/result` requests, resolved into the pending
//      tool call by callId.
//
// WHY A SEPARATE FILE: the same chain rule as every face before it — a
// cordis patch overlay cannot rewrite an inserted row's plugin name, only
// disable + insert. matters.patch.yml (written by dsh-profile.js's
// writeMattersPatch, AFTER serving-questions.patch.yml) swaps the row:
// disable `platform-serving-questions-server`, insert `platform-matters-server`
// pointing at this file.
//
// The facet route and the service credential never appear here: the child
// only names ops; the runner decides, calls, and answers.

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { ServingQuestionsSdkServer } from "./platform-serving-questions-bridge.js";
import { MatterWire, createMatterTools } from "./matter-tools.js";

// JsonRpcLineTransport lives in the SDK server package's own dependency
// closure — same re-anchoring as the preset bridge.
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

const name = "platform-matters-server";
const inject = ["agents"];
const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) });

class MattersSdkServer extends ServingQuestionsSdkServer {
  constructor(ctx, transportPeer, options) {
    super(ctx, transportPeer, options);
    this.matterWire = new MatterWire({
      notify: (method, params) => this.transport.notify(method, params),
    });
    this.disposers.push(() => this.matterWire.shutdown());
    // Deferred injection (the notify bridge's discipline): a composition
    // missing `tools` still boots and serves, just without the matter tools.
    ctx.inject(["tools"], (tctx) => {
      for (const tool of createMatterTools({ wire: this.matterWire })) tctx.tools.register(tool);
    });
  }

  async handleRequest(method, params) {
    if (method === "matterCall/result") return this.matterWire.settle(params);
    return super.handleRequest(method, params);
  }
}

// Wiring identical to the stock plugin's apply — the only change is the server
// class. Stdout stays reserved for protocol frames; shutdown exits 0.
function apply(ctx, config) {
  const resolvedConfig = config;
  const rootFiber = ctx.root.fiber;
  const input = config.input ?? process.stdin;
  const output = config.output ?? process.stdout;
  const exit = config.exit ?? ((code) => process.exit(code));
  const transportPeer = new JsonRpcLineTransport(input, output);
  const server = new MattersSdkServer(ctx, transportPeer, {
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

export { Config, MattersSdkServer, apply, inject, name };
