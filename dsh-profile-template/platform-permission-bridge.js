// platform-permission-bridge.js — the permission-mode extension of the
// platform's preset bridge (add-permission-mode-selector).
//
// Subclasses PlatformSdkServer (from ./platform-preset-bridge.js) to expose
// the composed dsh-permission-presets table to the host:
//
//   1. `permissions/list` returns the roster with client presentation
//      ({name,label,description}) plus the session's effective preset — the
//      last `permission/preset` session event this child saw, else the
//      deployment default. An absent service degrades to an empty roster.
//   2. `permissions/set` applies a preset to the LIVE session via the
//      runtime's PermissionPresetService.set — no child restart (unlike
//      preset/model/workspace switches). Unknown names throw (JSON-RPC error).
//
// WHY A SEPARATE FILE (not two more branches in platform-preset-bridge.js):
// the preset bridge is owned by the add-dsh-agent-presets change, and a cordis
// patch overlay cannot rewrite an inserted row's plugin name — it can only
// disable + insert. So this file subclasses that class, and a third overlay
// (permissions.patch.yml, written by dsh-profile.js AFTER presets.patch.yml)
// swaps the row: disable `platform-sdk-server`, insert
// `platform-permission-server` pointing at this file. Layer order in the
// spawn args matters and is fixed by dsh-bridge.js.
//
// The apply() wiring duplicates the small stock apply with the server class
// swapped — the parent's apply closes over its own class, so it cannot be
// reused. Stdout stays reserved for protocol frames.

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { PlatformSdkServer } from "./platform-preset-bridge.js";

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

const name = "platform-permission-server";
const inject = ["agents"];
const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) });

class PermissionSdkServer extends PlatformSdkServer {
  // sessionId → the last `permission/preset` value this child recorded. Fresh
  // per child generation (a restart resets permission to the deployment
  // default, and this map resets with it).
  permissionBySession = new Map();

  constructor(ctx, transportPeer, options) {
    super(ctx, transportPeer, options);
    // Same subscription the parent uses for session.event fan-out, filtered
    // to the one knob the platform renders. The platform ALSO receives these
    // as session.event notifications — this map just answers `permissions/list`
    // without replaying the session log.
    this.disposers.push(
      ctx.on("session/event", (session, event) => {
        if (event?.type === "permission/preset") {
          this.permissionBySession.set(String(session.id), event.data?.preset ?? null);
        }
      }),
    );
  }

  async handleRequest(method, params) {
    if (method === "permissions/list") {
      const service = this.ctx.get("permissionPresets");
      if (service === undefined) return { options: [], current: null };
      const options = service.names.map((n) => {
        const o = service.optionOf(n);
        return { name: o.value, label: o.name, description: o.description ?? "" };
      });
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
      const current =
        (sessionId && this.permissionBySession.get(sessionId)) || service.defaultPreset;
      return { options, current };
    }
    if (method === "permissions/set") {
      const service = this.ctx.get("permissionPresets");
      if (service === undefined) throw new Error("no permission service is composed");
      // getOrCreateSession (not a bare map read): the web session is created
      // lazily on first prompt, but a user may flip the mode BEFORE ever
      // prompting — the switch then creates the session (pinning its initial
      // permission facts) and applies the choice on top. The creation lock /
      // cache machinery in the parent is reused unchanged.
      const rec = await this.getOrCreateSession(params?.sessionId);
      // service.set appends the durable `permission/preset` event and writes
      // the sandbox/approval knobs through their canonical setters; an unknown
      // name throws → JSON-RPC error → a WS error to the requesting client.
      service.set(rec.handle.agent.session, params.name);
      return { current: params.name };
    }
    return super.handleRequest(method, params);
  }
}

// Wiring identical to the stock plugin's apply — the only change is the server
// class (and the extra session/event subscription inside its constructor).
function apply(ctx, config) {
  const resolvedConfig = config;
  const rootFiber = ctx.root.fiber;
  const input = config.input ?? process.stdin;
  const output = config.output ?? process.stdout;
  const exit = config.exit ?? ((code) => process.exit(code));
  const transportPeer = new JsonRpcLineTransport(input, output);
  const server = new PermissionSdkServer(ctx, transportPeer, {
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

export { Config, PermissionSdkServer, apply, inject, name };
