// Unit tests — fleet carrier configuration (add-fleet-carrier).
//
// Pins the spec contracts:
//   - agent-fleet-carrier ①: three-layer resolution (member > fleet
//     constraints > env default > auto) with strict precedence; carrier rides
//     the materialized spec and drifts in place (task id/session untouched);
//   - ②: runner routing via the catalog's a2a entry; fail-open two sources
//     (runner-no-entry / worker-pool-inactive) recorded in detail, never a
//     refused round;
//   - ③: the worker-pool claim gate (cell/runner not claimed) and the
//     per-fleet admission cap (stay queued, FIFO on release).
//
// Run: node --test scripts/test-fleet-carrier.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-carrier-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
delete process.env.CELL_CARRIER_DEFAULT;
delete process.env.FLEET_MAX_INFLIGHT;

const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { resolveTaskCarrier, runnerEntryFor, attachCronRunner } = await import("../server/cron-runner.js");
const { materializedSpec, specDrift } = await import("../server/fleet-reconcile.js");
const { CARRIERS } = await import("../server/fleet-orchestration.js");

const DB_FILE = path.join(tmpRoot, `fleets-${Date.now()}.db`);
const db = createFleetDatabase({ file: DB_FILE });
db.createFleet({
  id: "fleet_c1", name: "承载舰队", ownerEmail: "c@test", state: "active", decisionPolicy: null,
  sourceTemplate: null, defaultModel: null, effort: null, contextBudget: null,
  orchestration: { posts: [], edges: [], constraints: { carrier: "worker" } },
  createdAt: Date.now(), updatedAt: Date.now(),
});
db.createMember({ id: "m_cell", fleetId: "fleet_c1", title: "驻留岗", parentId: null, targetKind: "persona", targetId: "pack-a", kpiSlots: [], cadence: null, sortKey: 0, carrier: "cell", createdAt: Date.now(), updatedAt: Date.now() });
db.createMember({ id: "m_unset", fleetId: "fleet_c1", title: "随队岗", parentId: null, targetKind: "persona", targetId: "pack-b", kpiSlots: [], cadence: null, sortKey: 1, createdAt: Date.now(), updatedAt: Date.now() });

const job = (over = {}) => ({
  id: "job_c1", sessionId: "cron-c1", prompt: "跑", preset: "pack-a", targetType: "persona",
  sourceTag: { fleetId: "fleet_c1", memberId: "m_cell" },
  ...over,
});

// ── ① three-layer resolution ────────────────────────────────────────────────
test("resolution: member beats fleet beats env beats auto", () => {
  const inject = { db };
  // member=cell over fleet=worker
  assert.equal(resolveTaskCarrier(job(), inject), "cell");
  // fleet=worker applies when the member is unset
  assert.equal(resolveTaskCarrier(job({ sourceTag: { fleetId: "fleet_c1", memberId: "m_unset" } }), inject), "worker");
  // env default applies when both unset (different fleet without constraints)
  process.env.CELL_CARRIER_DEFAULT = "runner";
  assert.equal(resolveTaskCarrier(job({ sourceTag: { fleetId: "fleet_other", memberId: "m_x" } }), inject), "runner");
  delete process.env.CELL_CARRIER_DEFAULT;
  // auto at the bottom
  assert.equal(resolveTaskCarrier(job({ sourceTag: { fleetId: "fleet_other", memberId: "m_x" } }), inject), "auto");
  // task-level carrier rides first (materialized placement)
  assert.equal(resolveTaskCarrier(job({ carrier: "runner" }), inject), "runner");
});

test("materialization: carrier rides the spec and drifts in place (id/session untouched)", () => {
  const fleet = { id: "fleet_c1", name: "承载舰队" };
  const member = { id: "m_cell", title: "驻留岗", carrier: "worker", cadence: { cron: "0 9 * * *", tz: null, promptTemplate: "跑" } };
  const spec = materializedSpec({ fleet, member });
  assert.equal(spec.carrier, "worker");
  const task = { cron: spec.cron, carrier: "cell", sessionId: "cron-keep", preset: "pack-a" };
  const changes = specDrift(task, spec);
  assert.equal(changes.carrier, "worker");
  assert.equal(changes.sessionId, undefined, "session untouched");
  assert.equal(changes.cron, undefined, "schedule untouched");
  assert.equal(CARRIERS.join("|"), "auto|cell|worker|runner");
});

// ── ② runner routing + fail-open at the seam ────────────────────────────────
function carrierCtx({ listAgents, runnerEntry = true }) {
  const ctx = {
    currentPreset: "persona-a",
    isStreaming: false,
    sessionCollectors: new Map(),
    sessionVersion: 1,
    broadcast: () => {},
    onRuntimeIdle: () => {},
    reserveRuntime: () => () => {},
    switchPresetTo: async (_p) => ({ ok: true }),
    dshBridge: {
      isReady: () => true,
      hasLiveMethod: () => false, // legacy path — keeps preset semantics out of the way
      prompt: async (sessionId, _blocks) => {
        const collector = ctx.sessionCollectors.get(sessionId);
        collector?.({
          method: "session.event",
          params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: `远端输出 ${sessionId}` }] } } } },
        });
        collector?.({ method: "session.status", params: { status: "idle" } });
      },
    },
    executors: [],
  };
  const entry = runnerEntry ? { id: "registry-packs-p-pack-a", mode: "a2a", name: "Runner X", url: "https://registry.test/agent/packs/p/pack-a/" } : null;
  attachCronRunner(ctx, {
    listAgents: listAgents ?? (() => (entry ? [entry] : [])),
    runPersona: async (_c, j) => {
      ctx.executors.push(["persona", j.preset]);
      return { ok: true, text: "主链输出" };
    },
    runA2a: async (_c, j) => {
      ctx.executors.push(["remote", j.preset]);
      return { ok: true, text: "远端输出" };
    },
  });
  return ctx;
}

test("runner declared + catalog entry (agent key match) → remote executor with the entry's id", async () => {
  const ctx = carrierCtx({});
  const out = await ctx.runCronJobTurn(job({ carrier: "runner" }), { turnTimeoutMs: 2000 });
  assert.equal(out.ok, true);
  assert.deepEqual(ctx.executors[0], ["remote", "registry-packs-p-pack-a"]);
});

test("runner declared without deployment → fail-open primary chain, recorded", async () => {
  const ctx = carrierCtx({ runnerEntry: false });
  const out = await ctx.runCronJobTurn(job({ carrier: "runner" }), { turnTimeoutMs: 2000 });
  assert.equal(out.ok, true, "the round is NEVER refused");
  assert.deepEqual(ctx.executors[0], ["persona", "pack-a"]);
  assert.match(out.detail?.carrierFallback ?? "", /runner-no-entry/);
});

test("cell declared → primary chain even with the pool active (claim gate)", async () => {
  // The claim gate is covered at the pool level below; here the cell carrier
  // routes to the persona executor through the seam.
  const ctx = carrierCtx({});
  const out = await ctx.runCronJobTurn(job({ carrier: "cell" }), { turnTimeoutMs: 2000 });
  assert.equal(out.ok, true);
  assert.deepEqual(ctx.executors[0], ["persona", "pack-a"]);
});

// ── ② runner entry lookup (add-runner-route-key-match: agent-KEY matching) ───
test("runnerEntryFor matches the deployed agent key (registry path tail), ignores chat entries", () => {
  const rosterPresetId = (id) => String(id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const agents = [
    { id: "chat-agent", mode: "chat", name: "Chat" },
    // The registry-bridge shape: catalog id is prefixed, the route rides the url's /agent<path>/.
    { id: "registry-packs-x-runner", mode: "a2a", name: "Runner X", url: "https://registry.test/agent/packs/x/runner/" },
  ];
  const job = { id: "job_t1", preset: "runner" };
  assert.equal(runnerEntryFor(job, { listAgents: () => agents, rosterPresetId })?.id, "registry-packs-x-runner", "path tail (agent key) matches the persona key");
  assert.equal(runnerEntryFor({ id: "job_t2", preset: "no-such" }, { listAgents: () => agents, rosterPresetId }), null, "no entry → null (runner-no-entry at the caller)");
});

test("runnerEntryFor: cross-pack same agent key → ambiguous fail-open, never a guess", () => {
  const rosterPresetId = (id) => String(id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const agents = [
    { id: "registry-packs-aaa-reception", mode: "a2a", url: "https://registry.test/agent/packs/aaa/reception/" },
    { id: "registry-packs-bbb-reception", mode: "a2a", url: "https://registry.test/agent/packs/bbb/reception/" },
  ];
  const job = { id: "job_t3", preset: "reception" };
  assert.equal(runnerEntryFor(job, { listAgents: () => agents, rosterPresetId }), null, "ambiguous → null");
  assert.equal(job.carrierFallback, "runner-ambiguous", "the reason is recorded on the job");
});

test("runnerEntryFor: a raw path field wins over the url parse", () => {
  const rosterPresetId = (id) => String(id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const agents = [
    { id: "registry-legacy", mode: "a2a", path: "/packs/p/keeper/", url: "https://registry.test/agent/some/other/" },
  ];
  assert.equal(runnerEntryFor({ id: "job_t4", preset: "keeper" }, { listAgents: () => agents, rosterPresetId })?.id, "registry-legacy");
});

// ── ③ claim gate + admission cap at the pool level ───────────────────────────
process.env.TASK_WORKER_MAX = "2";
const engine = await import("../task-engine.js");
const { attachWorkerPool } = await import("../server/worker-slots.js");

class FakeBridge {
  static byPersona = new Map();
  constructor(params) {
    this.params = params;
    this.persona = params.agentPreset;
    this.prompts = [];
    FakeBridge.byPersona.set(this.persona, this);
  }
  async start() { this.ready = true; }
  isReady() { return this.ready && !this.closed; }
  async prompt(sessionId, blocks) {
    this.prompts.push({ sessionId, blocks });
    this.params.onEvent({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "stub reply" }] } } } } });
    await new Promise((resolve) => { this.release = resolve; });
    this.params.onEvent({ method: "session.status", params: { status: "idle" } });
  }
  emit(notif) { this.params.onEvent(notif); }
  close() { this.closed = true; }
}

const releaseAll = () => {
  for (const b of FakeBridge.byPersona.values()) b.release?.();
};
test.after(() => releaseAll());

let poolReady = false;
async function bootPoolOnce() {
  if (poolReady) return;
  process.env.CRON_STORAGE_PATH = path.join(tmpRoot, "jobs");
  fs.mkdirSync(process.env.CRON_STORAGE_PATH, { recursive: true });
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => ({ ok: true }), // the primary chain completes instantly
    isBusy: () => false,
  });
  const ctx = { broadcast: () => {}, sessionCollectors: new Map(), workerSpawnParams: { provider: "finddata", model: "stub" } };
  attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });
  poolReady = true;
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test("claim gate: a cell-carried task is NOT claimed by an active pool", async () => {
  await bootPoolOnce();
  const t = engine.createManualTask({ prompt: "主链活", persona: "pack-a", initiator: "s1", carrier: "cell", sourceTag: { fleetId: "fleet_c1", memberId: "m_cell" } });
  await settle(); await settle();
  assert.equal(engine.getTask(t.id).state, "done", "the primary chain ran it to completion");
  assert.equal(FakeBridge.byPersona.get("pack-a")?.prompts.length ?? 0, 0, "no worker claimed it");
});

test("admission gate: second fleet task stays queued at the cap, FIFO on release", async () => {
  await bootPoolOnce();
  process.env.FLEET_MAX_INFLIGHT = "1";
  try {
    const a = engine.createManualTask({ prompt: "A", persona: "pack-b", initiator: "s1", origin: { fleet: { fleetId: "fleet_c1", memberId: "m1" } } });
    const b = engine.createManualTask({ prompt: "B", persona: "pack-c", initiator: "s1", origin: { fleet: { fleetId: "fleet_c1", memberId: "m2" } } });
    await settle(); await settle();
    assert.equal(engine.getTask(a.id).state, "running", "first fleet task claimed");
    assert.equal(engine.getTask(b.id).state, "queued", "second stays queued at the cap");
    FakeBridge.byPersona.get("pack-b").release?.();
    await settle(); await settle();
    assert.equal(engine.getTask(b.id).state, "running", "FIFO proceeds after release");
    FakeBridge.byPersona.get("pack-c")?.release?.();
  } finally {
    delete process.env.FLEET_MAX_INFLIGHT;
  }
});

// ── ④ packId disambiguation (add-runner-packid-disambiguation) ───────────────
test("runnerEntryFor: member packId pins the cross-pack same-key hit", () => {
  const rosterPresetId = (id) => String(id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const agents = [
    { id: "registry-packs-aaa-reception", mode: "a2a", url: "https://registry.test/agent/packs/aaa/reception/" },
    { id: "registry-packs-bbb-reception", mode: "a2a", url: "https://registry.test/agent/packs/bbb/reception/" },
  ];
  const job = { id: "job_p1", preset: "reception", packId: "bbb" };
  const hit = runnerEntryFor(job, { listAgents: () => agents, rosterPresetId, packId: "bbb" });
  assert.equal(hit?.id, "registry-packs-bbb-reception", "the pack binding pins the exact deployment");
  assert.equal(job.carrierFallback, undefined, "no fail-open when the pin resolves");
});

test("runnerEntryFor: packId pin misses → ambiguity still fails open honestly", () => {
  const rosterPresetId = (id) => String(id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const agents = [
    { id: "registry-packs-aaa-reception", mode: "a2a", url: "https://registry.test/agent/packs/aaa/reception/" },
    { id: "registry-packs-bbb-reception", mode: "a2a", url: "https://registry.test/agent/packs/bbb/reception/" },
  ];
  const job = { id: "job_p2", preset: "reception" };
  // no packId → ambiguous (unchanged behavior)
  assert.equal(runnerEntryFor(job, { listAgents: () => agents, rosterPresetId, packId: null }), null);
  assert.equal(job.carrierFallback, "runner-ambiguous");
  // a packId matching NEITHER deployment → the pin filters nothing → still ambiguous
  const job3 = { id: "job_p3", preset: "reception" };
  assert.equal(runnerEntryFor(job3, { listAgents: () => agents, rosterPresetId, packId: "zzz" }), null);
  assert.equal(job3.carrierFallback, "runner-ambiguous");
});

test("packId survives the row round-trip: create→get and update→get both read it back", () => {
  // The deserialize read face must map pack_id — a write-only column would
  // silently null the pin at materialization (reconcile reads the hydrated
  // row, never the write path's arguments).
  db.createMember({ id: "m_pin", fleetId: "fleet_c1", title: "钉包岗", parentId: null, targetKind: "persona", targetId: "reception", kpiSlots: [], cadence: null, sortKey: 2, packId: "bbb", createdAt: Date.now(), updatedAt: Date.now() });
  assert.equal(db.getMember("m_pin")?.packId, "bbb", "createMember persists and getMember hydrates packId");
  db.updateMember("m_pin", { packId: "ccc" });
  assert.equal(db.getMember("m_pin")?.packId, "ccc", "updateMember persists and getMember hydrates packId");
  db.updateMember("m_pin", { packId: null });
  assert.equal(db.getMember("m_pin")?.packId, null, "null clears the pin");
});

// ── ③ 岗位级顶替豁免（3.2 的 manifest 入口）──────────────────────────────
//
// 这条入口以前只存在于注释里（task-engine 写着"岗位可在 manifest 用
// noSupersede: true 豁免"），但没有任何代码把 manifest 读进记录 ——
// 于是这个承诺是空的。这里钉三件事：不声明 = 不写字段；声明 = 送到 spec 且能
// 就地改回；默认行为逐字节不变。
test("noSupersede: 不声明就不写键（记录形状与加入本字段前一致）", () => {
  const fleet = { id: "fleet_c1", name: "承载舰队" };
  const member = { id: "m_cell", title: "驻留岗", cadence: { cron: "0 9 * * *", tz: null, promptTemplate: "跑" } };
  const spec = materializedSpec({ fleet, member });
  assert.equal(spec.noSupersede, undefined, "默认不得落这个键");
  const changes = specDrift({ cron: spec.cron, preset: "pack-a" }, spec);
  assert.equal(changes.noSupersede, undefined, "无声明时也不许产生 drift");
});

test("noSupersede: 声明后进 spec，并能就地改回（清掉键而不是留 false）", () => {
  const fleet = { id: "fleet_c1", name: "承载舰队" };
  const member = { id: "m_cell", title: "驻留岗", noSupersede: true,
    cadence: { cron: "0 9 * * *", tz: null, promptTemplate: "跑" } };
  const spec = materializedSpec({ fleet, member });
  assert.equal(spec.noSupersede, true);

  const task = { cron: spec.cron, preset: "pack-a" };
  assert.equal(specDrift(task, spec).noSupersede, true, "新声明要产生 drift");

  // 撤回声明 → drift 要把字段改成 false，由 updateJob 删键
  const cleared = materializedSpec({ fleet, member: { ...member, noSupersede: false } });
  const changes = specDrift({ ...task, noSupersede: true }, cleared);
  assert.equal(changes.noSupersede, false, "撤回也要产生 drift，否则会永久豁免");
});
