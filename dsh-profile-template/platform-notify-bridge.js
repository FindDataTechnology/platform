// platform-notify-bridge.js — the notification face of the platform's bridge
// (add-agent-notifications D1/D3).
//
// Subclasses PlatformSdkServer (from ./platform-preset-bridge.js) to compose
// the `bot_notify` capability into a deployed child — ONLY the agent-runner's
// children get this row (compose.js writes notify.patch.yml); the platform's
// own web children keep their bridge chain untouched.
//
// WHAT IT ADDS:
//   1. the model-facing `bot_notify` tool (bot-notify.js), whose calls ride
//      `botNotify/send` notifications up to the runner;
//   2. the host's `botNotify/result` requests, resolved into the pending tool
//      call by notifyId.
//
// WHY A SEPARATE FILE (not two more branches in platform-preset-bridge.js):
// the same reason the permission and user-questions faces are separate — a
// cordis patch overlay cannot rewrite an inserted row's plugin name, only
// disable + insert. So this file subclasses the class and notify.patch.yml
// (written by dsh-profile.js's writeNotifyPatch, AFTER presets.patch.yml)
// swaps the row: disable `platform-sdk-server`, insert `platform-notify-server`
// pointing at this file.
//
// The relay credential and the deployment's channel binding never appear here:
// the child only names events; the runner decides, forwards, and answers.

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { PlatformSdkServer } from "./platform-preset-bridge.js";
import { BotNotifyWire, createBotNotifyTool } from "./bot-notify.js";

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

const name = "platform-notify-server";
const inject = ["agents"];
const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) });

class NotifySdkServer extends PlatformSdkServer {
  constructor(ctx, transportPeer, options) {
    super(ctx, transportPeer, options);
    this.botNotify = new BotNotifyWire({
      notify: (method, params) => this.transport.notify(method, params),
    });
    // Shutdown ladder: parked calls settle as structured failures so no tool
    // call outlives the transport that would answer it.
    this.disposers.push(() => this.botNotify.shutdown());
    // Deferred injection (NOT a plugin-level inject): the tools service is
    // composed in every real profile, but the SDK server itself must never be
    // gated on it — a composition missing `tools` still boots and serves, just
    // without the notify tool.
    ctx.inject(["tools"], (tctx) => {
      tctx.tools.register(createBotNotifyTool({ wire: this.botNotify }));
    });
  }

  async handleRequest(method, params) {
    if (method === "botNotify/result") return this.botNotify.settle(params);
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
  const server = new NotifySdkServer(ctx, transportPeer, {
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

export { Config, NotifySdkServer, apply, inject, name };