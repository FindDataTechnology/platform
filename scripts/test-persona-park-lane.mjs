// Unit tests — per-session persona parking in the scheduled lane
// (add-cell-session-persona).
//
// Pins the executor contracts the spec deltas define:
//   - cron-module ADDED: the scheduled lane parks the turn's preset onto the
//     turn's child conversation id before its first prompt — zero restarts,
//     the runtime default is never moved, the fallback is explicit and
//     recorded (detail.presetPath "parked" | "legacy:<reason>"), fleet rounds
//     park the fresh rotated id each round, plain bound-session tasks park
//     once per child generation and re-park after a generation change;
//   - scheduling-cluster-aware: covered in test-cluster-park-restore below
//     via the cluster executor (all-parked fan-out skips the preset restore;
//     a legacy member still restores exactly as before).
//
// Run: node --test scripts/test-persona-park-lane.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "persona-park-lane-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(
  path.join(process.env.DSH_HOME, ".agent-presets.defs.json"),
  JSON.stringify([{ id: "pack-alpha-analyst", entryId: "pack-alpha-analyst", name: "Alpha Analyst" }]),
);

const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const { attachCronRunner } = await import("../server/cron-runner.js");
const { createClusterDatabase, setClusterDatabase } = await import("../server/routes/clusters-db.js");
const { reanchorInitiatorPersona } = await import("../server/delegation-aggregator.js");

await initDb();
await chatHistory.initChatHistory();

const fleetJob = (over = {}) => ({
  id: "job_f1",
  sessionId: "cron-9",
  prompt: "巡逻",
  preset: "persona-a",
  targetType: "persona",
  sessionTitle: "营销舰 · 巡逻岗",
  sourceTag: { fleetId: "fleet-1", memberId: "m-1" },
  ...over,
});

// A park-capable fake bridge: records park calls and generation clears. The
// prepared map mirrors the real bridge's contract (test-bridge-preset-park
// pins the real class against a fake child; this fake mirrors its behavior).
function parkBridge(ctx, { capability = true, refuse = null } = {}) {
  const prepared = new Map();
  return {
    parks: [], // { sessionId, presetId }
    generations: 0,
    isReady: () => true,
    hasLiveMethod: (m) => capability && m === "preset/set",
    preparedPreset: (sid) => prepared.get(sid) ?? null,
    setPreset: async ({ sessionId, presetId }) => {
      if (refuse) throw new Error(refuse);
      ctx.parkBridge.parks.push({ sessionId, presetId });
      prepared.set(sessionId, presetId);
      return true;
    },
    deleteSession: async () => true,
    prompt: async (sessionId, blocks) => {
      ctx.prompts.push({ sessionId, text: blocks[0].text });
      const collector = ctx.sessionCollectors.get(sessionId);
      collector?.({
        method: "session.event",
        params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: `回合输出 ${sessionId}` }] } } } },
      });
      collector?.({ method: "session.status", params: { status: "idle" } });
    },
    __clearGeneration: () => prepared.clear(), // the real bridge clears on #spawn
  };
}

function parkCtx({ streaming = false } = {}) {
  const ctx = {
    currentPreset: "persona-a",
    isStreaming: streaming,
    sessionCollectors: new Map(),
    sessionVersion: 1,
    broadcast: () => {},
    onRuntimeIdle: () => {},
    reserveRuntime: () => {
      ctx.reservations += 1;
      return () => {};
    },
    reservations: 0,
    // The job carries `sourceTag.fleetId`, so the round goes through
    // normalizeModelForJob; a fleet-attributed round with no model plan is
    // refused before it runs (ledger E28). Without the plan every case below
    // read the refusal as "the park path did not park" (measured:
    // `modeled={"ok":false,"err":"post model resolution unavailable …"}` right
    // after the readiness gate). Same minimal shape as test-empty-turn-billing.
    //
    // 合并时同一个夹具里 `resolveFleetModel` / `switchModelTo` 各写了两份，后一份生效；
    // 前一份在运行时永远不可达，已删——这里是唯一的那一份。
    resolveFleetModel: async (preset) => ({
      memberId: "m-1",
      preset,
      candidates: [{ model: "harness-model" }],
      notices: [],
      explicitChain: false,
    }),
    switchModelTo: async () => ({ ok: true }),
    recordFleetModelNotices: () => {},
    switchPresetTo: async (p) => {
      await new Promise((r) => setTimeout(r, 5)); // a real restart costs time — keep spinUpMs measurable
      ctx.switches.push(p);
      ctx.currentPreset = p;
      return { ok: true };
    },
    switches: [], // every runtime-default move — must stay empty on the park path
    prompts: [],
  };
  ctx.parkBridge = parkBridge(ctx);
  ctx.dshBridge = ctx.parkBridge;
  attachCronRunner(ctx);
  return ctx;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("the park path prompts without any restart and never moves the runtime default", async () => {
  const ctx = parkCtx();
  const out = await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 2000 });
  assert.equal(out.ok, true);
  assert.equal(out.detail?.presetPath, "parked");
  assert.equal(out.metering?.spinUpMs, 0, "parked = zero restart tax, measured");
  assert.equal(out.metering?.carrier, "cell", "enqueue default carrier");
  assert.ok(out.metering?.queueWaitMs === null || typeof out.metering?.queueWaitMs === "number", "queue wait measured or honest absence (direct seam call never enqueued)");
  assert.equal(ctx.switches.length, 0, "no runtime-default moves");
  assert.equal(ctx.reservations, 0, "no restart reservation on the park path");
  assert.equal(ctx.currentPreset, "persona-a", "the deployment default stays where the user left it");
  assert.equal(ctx.parkBridge.parks.length, 1);
  assert.equal(ctx.parkBridge.parks[0].sessionId, ctx.prompts[0].sessionId, "park targets THIS turn's child id");
  assert.ok(ctx.parkBridge.parks[0].sessionId.startsWith("cron-9#r"), "the fleet round's rotated id");
});

test("fleet rounds park the fresh rotated id every round", async () => {
  const ctx = parkCtx();
  await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 2000 });
  await pause(3);
  const out2 = await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 2000 });
  assert.equal(out2.ok, true);
  assert.equal(ctx.parkBridge.parks.length, 2, "each round parks its own fresh id");
  assert.notEqual(ctx.parkBridge.parks[0].sessionId, ctx.parkBridge.parks[1].sessionId, "rotation");
  assert.equal(ctx.switches.length, 0);
});

test("plain bound-session tasks park once per generation and re-park after a generation change", async () => {
  const ctx = parkCtx();
  const plain = fleetJob({ id: "job_p1", sessionId: "cron-8", sourceTag: undefined });

  const t1 = await ctx.runCronJobTurn(plain, { turnTimeoutMs: 2000 });
  const t2 = await ctx.runCronJobTurn(plain, { turnTimeoutMs: 2000 });
  assert.equal(t1.ok, true);
  assert.equal(t2.ok, true);
  assert.equal(ctx.parkBridge.parks.length, 1, "same generation + same preset → one park");
  assert.equal(ctx.parkBridge.parks[0].sessionId, "cron-8", "the bound session id (no rotation)");
  assert.equal(ctx.prompts[0].sessionId, "cron-8", "no rotation for plain tasks");

  ctx.parkBridge.__clearGeneration(); // child restarted → fresh generation
  const t3 = await ctx.runCronJobTurn(plain, { turnTimeoutMs: 2000 });
  assert.equal(t3.ok, true);
  assert.equal(ctx.parkBridge.parks.length, 2, "the new generation re-parks before the first prompt");
  assert.equal(ctx.switches.length, 0);
});

test("a live-session refusal falls back to the byte-parity restart path, recorded", async () => {
  const ctx = parkCtx();
  // A DIFFERENT live default — the legacy switch must actually fire (an equal
  // default short-circuits inside switchPresetForJob, as it always has).
  ctx.currentPreset = "standard";
  ctx.parkBridge = parkBridge(ctx, { refuse: "preset/set refused for session 's': persona is creation-time composition — start a new session to change presets" });
  ctx.dshBridge = ctx.parkBridge;
  const out = await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 2000 });
  assert.equal(out.ok, true, "the fallback runs the turn");
  assert.match(out.detail?.presetPath ?? "", /^legacy:live session composition mismatch/);
  assert.equal(ctx.reservations, 1, "the legacy path takes the restart reservation");
  assert.deepEqual(ctx.switches, ["persona-a"], "the legacy path switched the runtime default");
  assert.ok((out.metering?.spinUpMs ?? -1) > 0, "legacy = measured restart tax");
  assert.equal(ctx.currentPreset, "persona-a");
});

test("a child without the preset/set capability goes legacy without attempting a park", async () => {
  const ctx = parkCtx();
  ctx.currentPreset = "standard";
  ctx.parkBridge = parkBridge(ctx, { capability: false });
  ctx.dshBridge = ctx.parkBridge;
  const out = await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 2000 });
  assert.equal(out.ok, true);
  assert.match(out.detail?.presetPath ?? "", /^legacy:preset\/set unsupported/);
  assert.equal(ctx.parkBridge.parks.length, 0, "never attempted");
  assert.equal(ctx.switches.length, 1, "byte-parity restart path");
});

test("the park path still waits for a streaming user turn (close serialization discipline)", async () => {
  const ctx = parkCtx({ streaming: true });
  const runPromise = ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 400 });
  await pause(50);
  assert.equal(ctx.parkBridge.parks.length, 1, "the park itself does not need idle");
  assert.equal(ctx.prompts.length, 0, "no prompt while the user turn streams");
  ctx.isStreaming = false; // the user's turn finishes
  const out = await runPromise;
  assert.equal(out.ok, true);
  assert.equal(ctx.prompts.length, 1, "the turn ran after idle");
  assert.equal(out.detail?.presetPath, "parked");
});

// ── Cluster fan-out + delegation aggregator (section 3) ─────────────────────

const listAgentsFixture = () => [{ id: "pack-alpha-analyst", packId: "packA", mode: "chat", name: "Alpha 分析师" }];
const makeCluster = (id) => {
  const db = createClusterDatabase({ file: path.join(tmpRoot, `clusters-${id}-${Date.now()}.db`) });
  setClusterDatabase(db);
  db.create({
    id,
    name: "驻留集群",
    description: "",
    tags: [],
    agents: [{ packId: "packA", agentId: "pack-alpha-analyst", status: "active" }],
    createdAt: Date.now(),
  });
  return db;
};
const clusterJob = (id, clusterId) => ({
  id,
  prompt: "各自分析",
  preset: clusterId,
  targetType: "cluster",
  sessionId: `cron-${id}`,
  executionPolicy: {},
});

test("cluster fan-out on a park-capable child: zero restarts, member parked, no preset restore", async () => {
  makeCluster("cluster_park");
  const ctx = parkCtx();
  // NO runPersona injection — the REAL executor runs, so the park happens
  // inside the cluster loop and the restore segment reads the real drift.
  attachCronRunner(ctx, { listAgents: listAgentsFixture });
  const out = await ctx.runCronJobTurn(clusterJob("c_park", "cluster_park"), { turnTimeoutMs: 5000 });
  assert.equal(out.ok, true);
  assert.equal(ctx.switches.length, 0, "no runtime-default moves and no restore on the all-park path");
  assert.equal(ctx.reservations, 0, "no restart reservations");
  assert.equal(ctx.parkBridge.parks.length, 1, "the member parked onto its sub-session");
  assert.equal(ctx.parkBridge.parks[0].sessionId, "cron-c_park--pack-alpha-analyst");
});

test("cluster fan-out with a legacy-capability child restores the runtime default exactly as before", async () => {
  makeCluster("cluster_legacy");
  const ctx = parkCtx();
  ctx.currentPreset = "standard"; // a DIFFERENT default so the restore switch actually fires
  ctx.parkBridge = parkBridge(ctx, { capability: false });
  ctx.dshBridge = ctx.parkBridge;
  attachCronRunner(ctx, { listAgents: listAgentsFixture });
  const out = await ctx.runCronJobTurn(clusterJob("c_leg", "cluster_legacy"), { turnTimeoutMs: 5000 });
  assert.equal(out.ok, true);
  assert.equal(ctx.switches.length, 2, "member switch + restore switch");
  assert.equal(ctx.switches[1], "standard", "the fan-out restored the pre-task default");
  assert.equal(ctx.reservations, 1, "the member's legacy restart took the reservation");
});

test("aggregator re-anchor: park-capable child parks instead of switching; old child keeps the switch", async () => {
  // Park-capable: the initiator session gets the parked persona, the runtime
  // default never moves.
  const ctx = parkCtx();
  ctx.currentPreset = "pack-beta-target"; // where the fan-out left the default
  await reanchorInitiatorPersona(ctx, "sess-init", "persona-a");
  assert.deepEqual(ctx.switches, [], "no restart switch");
  assert.equal(ctx.parkBridge.parks.length, 1);
  assert.equal(ctx.parkBridge.parks[0].sessionId, "sess-init");
  assert.equal(ctx.parkBridge.parks[0].presetId, "persona-a");
  assert.equal(ctx.currentPreset, "pack-beta-target", "default untouched");

  // Old child: byte-parity switch, no park attempted.
  const ctx2 = parkCtx();
  ctx2.currentPreset = "pack-beta-target";
  ctx2.parkBridge = parkBridge(ctx2, { capability: false });
  ctx2.dshBridge = ctx2.parkBridge;
  await reanchorInitiatorPersona(ctx2, "sess-init", "persona-a");
  assert.deepEqual(ctx2.switches, ["persona-a"], "legacy switch fires");
  assert.equal(ctx2.parkBridge.parks.length, 0);

  // Same-persona: neither path does anything.
  const ctx3 = parkCtx();
  ctx3.currentPreset = "persona-a";
  await reanchorInitiatorPersona(ctx3, "sess-init", "persona-a");
  assert.deepEqual(ctx3.switches, []);
  assert.equal(ctx3.parkBridge.parks.length, 0);

  // Park refused (live session): degrades open, no throw, no switch.
  const ctx4 = parkCtx();
  ctx4.currentPreset = "pack-beta-target";
  ctx4.parkBridge = parkBridge(ctx4, { refuse: "preset/set refused for session 'x': persona is creation-time composition — start a new session to change presets" });
  ctx4.dshBridge = ctx4.parkBridge;
  await reanchorInitiatorPersona(ctx4, "sess-init", "persona-a");
  assert.deepEqual(ctx4.switches, [], "refusal never escalates to a restart");
});
