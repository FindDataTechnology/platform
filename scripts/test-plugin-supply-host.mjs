// dsh-plugin-supply — HOST-side guardrails (optimize-paas-module-audit N-17).
//
// The audit found this module's write-through logic (agent-session.js
// togglePluginBundle / getPluginBundles) had zero host unit tests: the only
// coverage was dsh contract ⑱, which runs in the *candidate* dsh tree and
// proves the child's plugin-manager semantics, not what the host does with the
// answer. The three-branch apply path (applied / restart-required / failed) is
// exactly the seam the spec pins ("Apply semantics follow the model-switch
// family"), so this file pins it here.
//
// These tests drive the attached session object with a fake bridge and assert
// the spec's scenarios:
//   - read-only inventory: one row per bundle, error rows surface not omitted
//     ("client reads the inventory"), unavailable bridge degrades to the last
//     known roster instead of an empty one;
//   - toggle persistence/apply: applied ⇒ no restart; restart-required ⇒ the
//     established bridge restart path; failed/cancelled ⇒ an explicit refusal
//     that leaves the reported roster intact;
//   - the streaming guard refuses with a reason the client can render
//     ("toggle rejected while streaming") and never reaches the bridge;
//   - "inventory reflects a toggle after re-application" — the roster is
//     re-read after the apply, so the next read reflects it.
//
// Per-profile isolation ("two cells diverge") is a patch-layer property of the
// child, not of these functions: it is pinned by the dsh contract and by
// dsh-profile's patch writer, so it is not duplicated as a fake-bridge test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// dsh-profile.js freezes DSH_HOME at module load; pin it to a throwaway home
// BEFORE the import so attaching a session never touches a real profile. The
// provider store is pinned for the same reason the credential-format test pins
// it (2026-10-14): a developer machine carrying llm-providers.json would make
// module load resolve refs a clean CI checkout never sees.
const HOME = mkdtempSync(join(tmpdir(), "fd-plugin-supply-"));
process.env.DSH_HOME = HOME;
const EMPTY_PROVIDERS = join(HOME, "llm-providers.json");
writeFileSync(EMPTY_PROVIDERS, JSON.stringify({ providers: [] }));
process.env.LLM_PROVIDERS_STORE = EMPTY_PROVIDERS;

const { attachAgentSession } = await import("../server/agent-session.js");

// A ctx with only what the plugin-supply closures touch: the bridge, the
// streaming flag, the broadcast sink, and the last-known roster.
function makeSession(bridge, { isStreaming = false } = {}) {
  const sent = [];
  const ctx = {
    dshBridge: bridge,
    isStreaming,
    broadcast: (msg) => sent.push(msg),
    pluginBundles: [],
  };
  attachAgentSession(ctx);
  return { ctx, sent };
}

function fakeBridge(overrides = {}) {
  const calls = [];
  const bridge = {
    isReady: () => true,
    async listPluginBundles() {
      calls.push(["list"]);
      return { bundles: [{ id: "supply-probe", enabled: true }] };
    },
    async setPluginBundleEnabled(name, enabled) {
      calls.push(["set", name, enabled]);
      return { application: "applied" };
    },
    async restart(opts) {
      calls.push(["restart", opts]);
    },
    ...overrides,
  };
  return { bridge, calls };
}

test("N-17 inventory: one row per bundle with its error metadata surfaced", async () => {
  const { bridge } = fakeBridge({
    async listPluginBundles() {
      return {
        bundles: [
          { id: "ok-bundle", description: "fine", enabled: true, phase: "active" },
          // A broken bundle must appear on its row, never be omitted.
          { id: "broken-bundle", enabled: false, error: "activation failed: no such export" },
        ],
      };
    },
  });
  const { ctx } = makeSession(bridge);
  const r = await ctx.getPluginBundles();
  assert.equal(r.available, true);
  assert.equal(r.bundles.length, 2);
  assert.equal(r.bundles[1].error, "activation failed: no such export");
});

test("N-17 inventory: an unready child degrades to the last known roster, not an empty one", async () => {
  const { bridge } = fakeBridge({ isReady: () => false });
  const { ctx, sent } = makeSession(bridge);
  ctx.pluginBundles = [{ id: "from-last-snapshot", enabled: true }];
  const r = await ctx.getPluginBundles();
  assert.equal(r.available, false);
  assert.deepEqual(r.bundles, [{ id: "from-last-snapshot", enabled: true }]);
  assert.equal(sent.length, 0);
});

test("N-17 inventory: a throwing bridge keeps the previous roster and does not error the read", async () => {
  const { bridge } = fakeBridge({
    async listPluginBundles() {
      throw new Error("transport closed");
    },
  });
  const { ctx } = makeSession(bridge);
  ctx.pluginBundles = [{ id: "known", enabled: true }];
  const r = await ctx.getPluginBundles();
  assert.equal(r.available, false);
  assert.deepEqual(r.bundles, [{ id: "known", enabled: true }]);
});

test("N-17 toggle: applied reconciles in place — no restart — and the roster is re-read", async () => {
  const roster = [{ id: "supply-probe", enabled: false }];
  const { bridge, calls } = fakeBridge({
    async listPluginBundles() {
      calls.push(["list"]);
      return { bundles: roster };
    },
  });
  const { ctx, sent } = makeSession(bridge);
  const r = await ctx.togglePluginBundle("supply-probe", false);
  assert.equal(r.ok, true);
  assert.equal(r.application, "applied");
  assert.deepEqual(calls, [["set", "supply-probe", false], ["list"]]);
  // "inventory reflects a toggle after re-application"
  assert.deepEqual(sent.at(-1), { type: "plugins_changed", bundles: roster });
});

test("N-17 toggle: restart-required goes through the established bridge restart path", async () => {
  const { bridge, calls } = fakeBridge({
    async setPluginBundleEnabled() {
      calls.push(["set"]);
      return { application: "restart-required" };
    },
  });
  const { ctx, sent } = makeSession(bridge);
  const r = await ctx.togglePluginBundle("supply-probe", false);
  assert.equal(r.ok, true);
  assert.equal(r.application, "restart-required");
  assert.deepEqual(calls.filter((c) => c[0] === "restart"), [["restart", {}]]);
  // The roster broadcast still happens, after the restart, so clients converge.
  assert.equal(sent.at(-1)?.type, "plugins_changed");
});

test("N-17 toggle: a failed apply is an explicit refusal and leaves the roster intact", async () => {
  const { bridge, calls } = fakeBridge({
    async setPluginBundleEnabled() {
      calls.push(["set"]);
      return { application: "failed", error: "version gate refused" };
    },
  });
  const { ctx, sent } = makeSession(bridge);
  ctx.pluginBundles = [{ id: "supply-probe", enabled: true }];
  const r = await ctx.togglePluginBundle("supply-probe", false);
  assert.equal(r.ok, false);
  assert.equal(r.error, "version gate refused");
  assert.deepEqual(calls, [["set"]]);
  assert.equal(sent.length, 0);
  assert.deepEqual(ctx.pluginBundles, [{ id: "supply-probe", enabled: true }]);
});

test("N-17 toggle: cancelled is refused with its own reason", async () => {
  const { bridge } = fakeBridge({
    async setPluginBundleEnabled() {
      return { application: "cancelled" };
    },
  });
  const { ctx } = makeSession(bridge);
  const r = await ctx.togglePluginBundle("supply-probe", false);
  assert.equal(r.ok, false);
  assert.match(r.error, /cancelled/i);
});

test("N-17 toggle: a bridge rejection surfaces as a renderable error, roster unchanged", async () => {
  const { bridge } = fakeBridge({
    async setPluginBundleEnabled() {
      throw new Error("unknown bundle: nope");
    },
  });
  const { ctx, sent } = makeSession(bridge);
  ctx.pluginBundles = [{ id: "supply-probe", enabled: true }];
  const r = await ctx.togglePluginBundle("nope", true);
  assert.equal(r.ok, false);
  assert.equal(r.error, "unknown bundle: nope");
  assert.equal(sent.length, 0);
  assert.deepEqual(ctx.pluginBundles, [{ id: "supply-probe", enabled: true }]);
});

test("N-17 toggle: rejected while streaming, with a busy reason, and the bridge is never called", async () => {
  const { bridge, calls } = fakeBridge();
  const { ctx, sent } = makeSession(bridge, { isStreaming: true });
  const r = await ctx.togglePluginBundle("supply-probe", false);
  assert.equal(r.ok, false);
  assert.match(r.error, /while the agent is responding/);
  assert.deepEqual(calls, []);
  assert.equal(sent.length, 0);
});

test("N-17 toggle: an unready child refuses instead of queueing", async () => {
  const { bridge, calls } = fakeBridge({ isReady: () => false });
  const { ctx } = makeSession(bridge);
  const r = await ctx.togglePluginBundle("supply-probe", false);
  assert.equal(r.ok, false);
  assert.match(r.error, /still initializing/);
  assert.deepEqual(calls, []);
});

test("N-17 toggle: a missing bundle name is refused before any bridge call", async () => {
  const { bridge, calls } = fakeBridge();
  const { ctx } = makeSession(bridge);
  for (const bad of ["", null, undefined, 42]) {
    const r = await ctx.togglePluginBundle(bad, true);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /bundle name is required/i);
  }
  assert.deepEqual(calls, []);
});
