// Unit tests — server/dsh-mcp-delivery (add-line-credential-renewal D5
// hardening after the fleet-cell incident 2026-10-24 13:46: a restart colliding
// with one already in flight lost the credential delivery silently).
// Run: node --test scripts/test-dsh-mcp-delivery.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { createCredentialDelivery } = await import("../server/dsh-mcp-delivery.js");

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

test("idle credential change restarts immediately (5.1 delivery branch)", async () => {
  const restarts = [];
  const d = createCredentialDelivery({
    isStreaming: () => false,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: silentLog,
  });
  const out = await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(out, "restarted");
  assert.deepEqual(restarts, ["/tmp/patch.yml"]);
  assert.equal(d.pending, false);
});

test("restart collision retries and delivers — the incident's silent loss is gone", async () => {
  let calls = 0;
  const restarts = [];
  const warns = [];
  const d = createCredentialDelivery({
    isStreaming: () => false,
    restart: async () => {
      calls += 1;
      if (calls <= 2) throw new Error("dsh restart already in progress");
      restarts.push(calls);
    },
    log: { ...silentLog, warn: (m) => warns.push(m) },
    retryDelaysMs: [1, 1],
  });
  const out = await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(out, "restarted");
  assert.equal(restarts.length, 1, "third attempt delivered");
  assert.equal(warns.length, 2, "each collision logged");
});

test("restart failure exhausts retries with a loud error (never silent)", async () => {
  const errors = [];
  let calls = 0;
  const d = createCredentialDelivery({
    isStreaming: () => false,
    restart: async () => { calls += 1; throw new Error("down"); },
    log: { ...silentLog, error: (m) => errors.push(m) },
    retryDelaysMs: [1, 1],
  });
  await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(calls, 3, "initial + 2 retries");
  assert.equal(errors.length, 1, "exhaustion logged at error level");
});

test("streaming change defers; drainIfIdle delivers at the turn boundary", async () => {
  let streaming = true;
  const restarts = [];
  const logs = [];
  const d = createCredentialDelivery({
    isStreaming: () => streaming,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: { ...silentLog, log: (m) => logs.push(m) },
  });
  const out = await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(out, "deferred");
  assert.equal(d.pending, true);
  assert.deepEqual(restarts, [], "nothing delivered while streaming");
  streaming = false;
  const drained = await d.drainIfIdle();
  assert.equal(drained, true);
  assert.deepEqual(restarts, ["/tmp/patch.yml"]);
  assert.equal(d.pending, false);
  assert.ok(logs.some((m) => m.includes("deferred")), "the defer decision is logged");
});

test("drainIfIdle no-ops while still streaming (never interrupts a fresh turn)", async () => {
  const d = createCredentialDelivery({
    isStreaming: () => true,
    restart: async () => { throw new Error("must not be called"); },
    log: silentLog,
  });
  await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(await d.drainIfIdle(), false, "streaming → no drain");
  assert.equal(d.pending, true, "still parked");
});

test("deferred past the cap, the poller forces delivery (wedged stream cannot hold the credential hostage)", async () => {
  const restarts = [];
  const warns = [];
  const d = createCredentialDelivery({
    isStreaming: () => true, // wedged forever
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: { ...silentLog, warn: (m) => warns.push(m) },
    maxDeferredMs: 30,
  });
  await d.onCredentialChange("/tmp/patch.yml");
  // The poller ticks every 250ms; the cap (30ms) expires on the first tick.
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(restarts, ["/tmp/patch.yml"], "forced delivery despite streaming");
  assert.ok(warns.some((m) => m.includes("cap")), "the force is logged as a warning");
  assert.equal(d.pending, false);
});

test("re-defer while pending keeps the original defer timestamp (cap measured from first defer)", async () => {
  let streaming = true;
  const restarts = [];
  const d = createCredentialDelivery({
    isStreaming: () => streaming,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: silentLog,
    maxDeferredMs: 100,
  });
  await d.onCredentialChange("/tmp/a.yml");
  await new Promise((r) => setTimeout(r, 60));
  await d.onCredentialChange("/tmp/b.yml"); // second change, same pending window
  streaming = false;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(restarts.includes("/tmp/b.yml"), "the latest patch is delivered");
  assert.equal(d.pending, false);
});

// ── fix-fleet-round-discipline D1: the shared-child busy predicate ──────────
// The controller consumes one opaque busy signal; what changes here is the
// signal server.js feeds it: web live turn OR any collector-registered turn
// on the shared child (cron/delegation register on taskTurnRegistry,
// bot-relay on sessionCollectors). These tests drive the controller through a
// fixture mirroring the exact wiring predicate — production 2026-10-24 lost
// 3 of 9 fleet rounds to the narrow `ctx.isStreaming`-only signal.

function sharedChildFixture() {
  const ctx = { isStreaming: false, taskTurnRegistry: new Map(), sessionCollectors: new Map() };
  const isStreaming = () =>
    Boolean(ctx.isStreaming) ||
    (ctx.taskTurnRegistry?.size ?? 0) > 0 ||
    (ctx.sessionCollectors?.size ?? 0) > 0;
  return { ctx, isStreaming };
}

test("fleet round in flight (collector registered) defers the restart — the 9-loss blind spot", async () => {
  const { ctx, isStreaming } = sharedChildFixture();
  const restarts = [];
  const d = createCredentialDelivery({
    isStreaming,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: silentLog,
  });
  ctx.sessionCollectors.set("cron-1#r7", () => {}); // a patrol round is streaming
  const out = await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(out, "deferred");
  assert.deepEqual(restarts, [], "no restart while a collector-registered turn runs");
});

test("collector settles → the poller drains at the turn boundary", async () => {
  const { ctx, isStreaming } = sharedChildFixture();
  const restarts = [];
  const d = createCredentialDelivery({
    isStreaming,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: silentLog,
  });
  ctx.sessionCollectors.set("cron-1#r7", () => {});
  await d.onCredentialChange("/tmp/patch.yml");
  ctx.sessionCollectors.delete("cron-1#r7"); // settle: the round just closed
  await new Promise((r) => setTimeout(r, 600)); // poller ticks every 250ms
  assert.deepEqual(restarts, ["/tmp/patch.yml"]);
  assert.equal(d.pending, false);
});

test("drainIfIdle re-checks the shared-child predicate (never races a fresh round)", async () => {
  const { ctx, isStreaming } = sharedChildFixture();
  const restarts = [];
  const d = createCredentialDelivery({
    isStreaming,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: silentLog,
  });
  ctx.taskTurnRegistry.set("job-9", () => {}); // delegation turn registered
  await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(await d.drainIfIdle(), false, "busy on a registered turn → no drain");
  ctx.taskTurnRegistry.delete("job-9");
  assert.equal(await d.drainIfIdle(), true);
  assert.deepEqual(restarts, ["/tmp/patch.yml"]);
});

test("cap never interrupts a legal long round; the wedge release survives (D2)", async () => {
  const { ctx, isStreaming } = sharedChildFixture();
  const restarts = [];
  const warns = [];
  const d = createCredentialDelivery({
    isStreaming,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: { ...silentLog, warn: (m) => warns.push(m) },
    maxDeferredMs: 400, // stands in for the 15min cap ≥ round budget
  });
  ctx.sessionCollectors.set("cron-1#r7", () => {});
  await d.onCredentialChange("/tmp/patch.yml");
  await new Promise((r) => setTimeout(r, 300)); // a poller tick lands while busy, under the cap
  assert.deepEqual(restarts, [], "a legal round (under the cap) is never force-interrupted");
  ctx.sessionCollectors.delete("cron-1#r7"); // the round self-terminates
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(restarts, ["/tmp/patch.yml"], "delivered at the boundary after the round ends");

  // Wedge release (existing semantics under the wider predicate): a turn
  // stuck past its own budget must not hold the credential hostage.
  ctx.sessionCollectors.set("cron-2#r8", () => {});
  await d.onCredentialChange("/tmp/patch2.yml");
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(restarts, ["/tmp/patch.yml", "/tmp/patch2.yml"], "wedged turn forced past the cap");
  assert.ok(warns.some((m) => m.includes("cap")), "the force is logged as a warning");
});

test("label param: non-credential fallback restarts log under their own name (D3)", async () => {
  const logs = [];
  const restarts = [];
  const d = createCredentialDelivery({
    isStreaming: () => false,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: { ...silentLog, log: (m) => logs.push(m) },
  });
  const out = await d.onCredentialChange(undefined, { label: "profile fallback" });
  assert.equal(out, "restarted");
  assert.equal(restarts.length, 1, "patchPath passed through untouched");
  assert.ok(logs.some((m) => m.includes("profile fallback")));
});
