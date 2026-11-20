// platform-connector-bridge.js — the facade reception's connector face
// (add-served-agent-connector-access D2).
//
// Subclasses MattersSdkServer so ONE row carries the whole facade face
// (notify + questions + matters + connector). The alternative — a second
// inserted row — cannot work: a cordis patch overlay can disable and insert,
// but two servers cannot both own the child's single JSON-RPC transport.
//
// Only the agent-runner's FACADE children get this row: compose.js writes
// connector.patch.yml when the descriptor carries a `facade` block. Every other
// child keeps the questions row and structurally never sees these tools.
//
// WHAT IT ADDS:
//   1. the model-facing connector_bindings / connector_call tools, whose calls
//      ride `connectorCall/send` notifications up to the runner;
//   2. the host's `connectorCall/result` requests, resolved into the pending
//      tool call by callId.
//
// The connector origin, the deployment token and the visitor's identity never
// appear here: the child only names a binding and a tool; the runner decides
// who the call runs as and answers.

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { MattersSdkServer } from "./platform-matters-bridge.js";
import { ConnectorWire, createConnectorTools } from "./connector-tools.js";

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

const name = "platform-connector-server";
const inject = ["agents"];
const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) });

class ConnectorSdkServer extends MattersSdkServer {
  constructor(ctx, transportPeer, options) {
    super(ctx, transportPeer, options);
    this.connectorWire = new ConnectorWire({
      notify: (method, params) => this.transport.notify(method, params),
    });
    this.disposers.push(() => this.connectorWire.shutdown());
    // Deferred injection (the notify bridge's discipline): a composition
    // missing `tools` still boots and serves, just without the connector tools.
    ctx.inject(["tools"], (tctx) => {
      for (const tool of createConnectorTools({ wire: this.connectorWire })) tctx.tools.register(tool);
    });
  }

  async handleRequest(method, params) {
    if (method === "connectorCall/result") return this.connectorWire.settle(params);
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
  const server = new ConnectorSdkServer(ctx, transportPeer, {
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

export { Config, ConnectorSdkServer, apply, inject, name };
