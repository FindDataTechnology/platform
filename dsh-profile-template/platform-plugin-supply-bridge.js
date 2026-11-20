// platform-plugin-supply-bridge.js — the dsh plugin-supply extension of the
// platform's user-questions bridge (add-dsh-plugin-supply).
//
// Subclasses UserQuestionsSdkServer (from ./platform-user-questions-bridge.js)
// to expose the profile's `pluginManager` service (composed by the dsh-base
// bundle) over the existing wire:
//
//   1. `plugins/list` returns the bundle roster: name, version, description,
//      enabled / installed / optional / removable flags, readOnlyReason and
//      error metadata. An absent service degrades to an empty roster (the
//      Plugins section renders "no bundles supplied", chat unaffected).
//   2. `plugins/set_enabled` toggles a bundle LAYER through the service's own
//      write semantics (profile manifest bundles-list edit + reload). The
//      result's `application` already encodes the apply story: "applied" when
//      the HMR reload reconciled the live composition in place,
//      "restart-required" when no HMR is present (the host then restarts the
//      child through the established restart path), "failed"/"cancelled"
//      otherwise with an error.
//
// v1 is bundle-level only: the row-level service method (setPluginEnabled)
// stays unused — the deployment whitelist is the supply, and the UI flips
// whole bundle layers. Runtime package installation (installBundle/removeBundle)
// is deliberately not exposed here: no route, no tool, no wire method.
//
// Overlay mechanics mirror the user-questions swap: plugin-supply.patch.yml
// (written by dsh-profile.js AFTER user-questions.patch.yml) disables the
// `platform-user-questions-server` row and inserts this subclass under a fresh
// `platform-plugin-supply-server` row; layer order is fixed by dsh-bridge.js.

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { UserQuestionsSdkServer } from "./platform-user-questions-bridge.js";

// JsonRpcLineTransport lives in the SDK server package's own dependency
// closure — same re-anchoring as the preset/permission/user-questions bridges.
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

const name = "platform-plugin-supply-server";
// `agents` rides the parent chain (session machinery). `pluginManager` is NOT
// hard-injected: an absent service must degrade to an empty roster, never
// abort the profile boot (spec: supply failures are observable, never
// catastrophic).
const inject = ["agents"];
const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) });

// Public row projection: the service's row carries loader internals (rows,
// overrides) the client has no business rendering; keep the display fields and
// flatten the error to a code + message pair.
function publicBundleRow(row) {
  const error =
    row?.error === undefined || row?.error === null
      ? undefined
      : typeof row.error === "string"
        ? { code: row.error }
        : {
            ...(typeof row.error.code === "string" ? { code: row.error.code } : {}),
            ...(typeof row.error.message === "string" ? { message: row.error.message } : {}),
          };
  return {
    id: row?.name,
    name: row?.name,
    ...(typeof row?.version === "string" ? { version: row.version } : {}),
    ...(typeof row?.description === "string" && row.description ? { description: row.description } : {}),
    enabled: row?.enabled === true,
    installed: row?.installed === true,
    optional: row?.optional === true,
    removable: row?.removable === true,
    ...(typeof row?.readOnlyReason === "string" ? { readOnlyReason: row.readOnlyReason } : {}),
    ...(error === undefined ? {} : { error }),
  };
}

class PluginSupplySdkServer extends UserQuestionsSdkServer {
  async handleRequest(method, params) {
    if (method === "plugins/list") {
      const service = this.ctx.get("pluginManager");
      if (service === undefined) return { bundles: [] };
      const rows = await service.listBundles();
      return { bundles: Array.isArray(rows) ? rows.map(publicBundleRow) : [] };
    }
    if (method === "plugins/set_enabled") {
      const service = this.ctx.get("pluginManager");
      if (service === undefined) throw new Error("no plugin manager is composed");
      const bundleName = typeof params?.name === "string" ? params.name : "";
      if (!bundleName) throw new Error("plugins/set_enabled requires a bundle name");
      const enabled = params?.enabled === true;
      // The service's `change()` absorbs failures into the result
      // ({application:"failed", error}) instead of throwing — turn that back
      // into a JSON-RPC error: refusals (unknown bundle, version gate) must
      // reach the client as the renderable reason they are, and the roster
      // stays unchanged (permissions/set precedent).
      const result = await service.setBundleEnabled(bundleName, enabled);
      const errorText = result?.error
        ? typeof result.error === "string"
          ? result.error
          : (result.error.message ?? result.error.code ?? "failed")
        : null;
      if (result?.application === "failed" || result?.application === "cancelled") {
        throw new Error(`plugins/set_enabled ${result.application}: ${errorText ?? bundleName}`);
      }
      return {
        name: bundleName,
        enabled,
        changed: result?.changed === true,
        application: typeof result?.application === "string" ? result.application : "unknown",
        ...(Array.isArray(result?.warnings) && result.warnings.length ? { warnings: result.warnings } : {}),
      };
    }
    return super.handleRequest(method, params);
  }
}

// Wiring identical to the stock plugin's apply — the only change is the server
// class (the parent chain supplies the rest).
function apply(ctx, config) {
  const resolvedConfig = config;
  const rootFiber = ctx.root.fiber;
  const input = config.input ?? process.stdin;
  const output = config.output ?? process.stdout;
  const exit = config.exit ?? ((code) => process.exit(code));
  const transportPeer = new JsonRpcLineTransport(input, output);
  const server = new PluginSupplySdkServer(ctx, transportPeer, {
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

export { Config, PluginSupplySdkServer, apply, inject, name };