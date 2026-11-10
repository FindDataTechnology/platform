// Unit tests for the run ledger (agent-fleet-runs, add-fleet-cockpit-v2).
//
// Covers the spec pins:
//   - additive migration: a v1-shaped fleets.db gains fleet_runs + the turn
//     columns; legacy rows read runId/usage null
//   - begin/end: root turn mints run + turn ids and opens the header; a
//     non-fleet job returns null (zero disturbance); usage lands as reported
//     (several provider shapes), never guessed
//   - chain through the seam: handoff / fanout tasks created by the trigger
//     inherit the run (parentTurnId × edgeKind), a mid-turn dispatch found by
//     post; three hops read as one tree under one runId
//   - settle: closes only when nothing is open or queued; excludes the task
//     whose turn just ended; idempotent; a late downstream re-opens and
//     re-closes with consistent totals
//   - broadcasts: run_updated(open) → turn_started → turn_ended →
//     run_updated(closed); payload is fleet-domain fields only
//   - trace tap: collectTurn feeds the trace store keyed by the ledger turn id
//     under the mirror session; FLEET_TRACE_TAP=0 disables it
//   - retention: dual condition (recent rows beyond N kept, old rows beyond N
//     pruned), pruneRuns ages closed headers only
//
// Run: node --test scripts/test-fleet-runs.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-runs-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const chatHistory = await import("../chat-history.js");
const cron = await import("../cron.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { recordTurnEvent, normalizeUsage } = await import("../server/fleet-events.js");
const { createFleetTurnLedger, traceTapEnabled } = await import("../server/fleet-runs.js");
const { attachCronRunner, collectTurn, roundChildSessionId } = await import("../server/cron-runner.js");
const { buildTurnRequest } = await import("../server/turn-request.js");

await initDb();
await chatHistory.initChatHistory();

// The engine's turn runner is routed to whichever seam the current test
// attached, so queued downstream tasks REALLY run through runCronJobTurn.
let seam = null;
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async (job, opts) => (seam ? seam(job, opts) : { ok: true, text: "ok" }),
  isBusy: () => false,
});

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
  seam = null;
});

// Drain the engine between tests, not just at the end of the file. The engine is
// a MODULE-level singleton while the fleet DB is swapped per test, so a task
// still queued from the previous test runs against the NEW db — its turn row
// lands in whichever run its `origin.fleet.fleetId` names (every test here uses
// `f_run`), and the next test's settle then sees an extra failed turn and
// reports `partial` where it asserted `ok` (test-fleet-runs:328 under load).
// Draining at the boundary is the minimal way to keep that work inside the test
// that created it.
afterEach(async () => {
  await engine.idle?.();
});

test.after(async () => {
  cron.shutdown?.();
  await engine.idle?.();
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function member(id, title = id) {
  return { id, title, parentId: null, targetKind: "persona", targetId: `p-${id}`, kpiSlots: [], cadence: null };
}

function fixtureFleet(db, { id = "f_run", members = [], orchestration = null } = {}) {
  const fleet = db.createFleet({ id, name: "账本舰队", ownerEmail: "owner@test", orchestration });
  for (const m of members) db.createMember({ ...m, fleetId: id });
  return fleet;
}

// A ctx shaped like server.js's wiring: ledger + recorder delegation + a
// handoff/fanout trigger that stamps the chain exactly as server.js does.
function buildCtx(db, { runPersona, trace = null, broadcast = () => {} } = {}) {
  const ctx = {
    session: { model: { id: "m0" } },
    taskTurnRegistry: new Map(),
    sessionCollectors: new Map(),
    broadcast,
    // 运行时就绪门（cron-runner 的 awaitRuntimeReadyForJob）：舰队任务在
    // dshBridge 缺席时会按 RUNTIME_READY_WAIT_MS = 120s 空等到上限——那正好
    // 等于本文件的测试超时，于是多跳链路用例永远 120s 红（这是本文件长期
    // 的「既有红」，不是链路逻辑坏了）。其他所有 fleet 测试都挂了 bridge
    // 替身，这里漏了；补一个「恒就绪」，门直接放行。
    dshBridge: { isReady: () => true },
  };
  ctx.fleetTurnLedger = createFleetTurnLedger({ db, broadcast: (m) => ctx.broadcast(m), engineRecords: () => engine.allRecords(), trace });
  ctx.recordFleetTurnEvent = (job, out, meta) =>
    meta?.ledgerTurn ? ctx.fleetTurnLedger.end(job, meta.ledgerTurn, out, meta) : recordTurnEvent(db, job, out, meta);
  ctx.triggerFleetHandoffs = async (job, out, ledgerTurn) => {
    const memberId = job.origin?.fleet?.memberId ?? job.sourceTag?.memberId ?? null;
    const fleetId = job.origin?.fleet?.fleetId ?? job.sourceTag?.fleetId ?? null;
    const f = db.getFleet(fleetId);
    const edges = f?.orchestration?.edges ?? [];
    const depth = (job.origin?.fleet?.depth ?? 0) + 1;
    const withChain = (fleet, kind) => {
      const chain = ctx.fleetTurnLedger.chainFor(ledgerTurn, kind);
      return chain ? { ...fleet, chain } : fleet;
    };
    const made = [];
    for (const e of edges) {
      if (e.kind === "handoff" && e.from === memberId) {
        made.push(engine.createManualTask({ prompt: `接棒:${out.text ?? out.error}`, persona: `p-${e.to}`, origin: { fleet: withChain({ fleetId, memberId: e.to, depth }, "handoff") } }).id);
      }
      if (e.kind === "fanout" && e.from === memberId) {
        for (const t of e.targets) {
          made.push(engine.createManualTask({ prompt: "扇出", persona: `p-${t}`, initiator: job.sessionId ?? null, origin: { fleet: withChain({ fleetId, memberId: t, depth, wave: 1 }, "fanout") } }).id);
        }
      }
    }
    return made.length ? made : null;
  };
  attachCronRunner(ctx, {
    runPersona: runPersona ?? (async () => ({ ok: true, text: "产出", usage: { input: 100, output: 20 } })),
    runA2a: async () => ({ ok: true }),
    listAgents: () => [],
  });
  seam = (job, opts) => ctx.runCronJobTurn(job, opts);
  return ctx;
}

function rootJob(fleetId, memberId, id = `j_${Math.random().toString(36).slice(2, 8)}`) {
  return { id, trigger: "schedule", targetType: "persona", preset: `p-${memberId}`, sessionId: `cron-${id}`, sourceTag: { fleetId, memberId } };
}

// ── 1. migration ────────────────────────────────────────────────────────────

test("additive migration: v1-shaped db gains fleet_runs + turn columns; legacy rows read null", () => {
  const file = path.join(tmpRoot, `legacy-${Date.now()}.db`);
  const raw = new Database(file);
  raw.exec(`CREATE TABLE fleets (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_email TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  raw.exec(`CREATE TABLE member_turn_events (id INTEGER PRIMARY KEY AUTOINCREMENT, fleet_id TEXT NOT NULL, member_id TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, error_kind TEXT, error TEXT, model TEXT, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, session_id TEXT)`);
  raw.prepare(`INSERT INTO member_turn_events (fleet_id, member_id, source, status, started_at, ended_at) VALUES ('f1','m1','cron','ok',1,2)`).run();
  raw.close();
  const db = createFleetDatabase({ file });
  const cols = db.db.prepare("PRAGMA table_info(member_turn_events)").all().map((c) => c.name);
  for (const c of ["turn_id", "run_id", "parent_turn_id", "edge_kind", "usage_input", "usage_output", "trace_turn_id"]) assert.ok(cols.includes(c), c);
  // 12 base columns + stopped_at/stop_reason (add-fleet-run-budget): the stop
  // facts ride the header, they are not a status value finalizeRun could
  // overwrite.
  const runCols = db.db.prepare("PRAGMA table_info(fleet_runs)").all().map((c) => c.name);
  assert.equal(runCols.length, 14);
  for (const c of ["stopped_at", "stop_reason"]) assert.ok(runCols.includes(c), c);
  const [legacy] = db.listTurnEvents("m1");
  assert.equal(legacy.runId, null);
  assert.equal(legacy.turnId, null);
  assert.equal(legacy.usage, null);
  db.close();
});

// ── 2. begin / end / usage ──────────────────────────────────────────────────

test("begin: root turn mints run + turn ids and opens the header; non-fleet job → null", () => {
  fixtureFleet(fleetDb, { members: [member("m_up")] });
  const ledger = createFleetTurnLedger({ db: fleetDb });
  const h = ledger.begin(rootJob("f_run", "m_up"), { startedAt: 1000 });
  assert.match(h.runId, /^run_/);
  assert.match(h.turnId, /^turn_/);
  assert.equal(h.parentTurnId, null);
  assert.equal(h.edgeKind, null);
  const run = fleetDb.getRun(h.runId);
  assert.equal(run.status, "open");
  assert.equal(run.rootSource, "cron");
  assert.equal(run.rootMemberId, "m_up");
  assert.equal(run.startedAt, 1000);
  assert.equal(ledger.lookupByMember("m_up")?.turnId, h.turnId);
  assert.equal(ledger.begin({ id: "x", trigger: "manual", preset: "stranger" }), null, "non-fleet: nothing opened");
  assert.equal(fleetDb.listRuns("f_run").total, 1);
});

test("end + settle: row carries turnId/runId/usage; header closes with SUM totals; settle is idempotent", () => {
  fixtureFleet(fleetDb, { members: [member("m_up")] });
  const ledger = createFleetTurnLedger({ db: fleetDb });
  const job = rootJob("f_run", "m_up");
  const h = ledger.begin(job, { startedAt: 1000 });
  const ev = ledger.end(job, h, { ok: true, text: "x", usage: { promptTokens: 300, completionTokens: 45 } }, { startedAt: 1000, endedAt: 2500 });
  assert.equal(ev.turnId, h.turnId);
  assert.equal(ev.runId, h.runId);
  assert.deepEqual(ev.usage, { input: 300, output: 45 });
  assert.equal(ledger.lookupByMember("m_up"), null, "unregistered on end");
  const closed = ledger.settle(h.runId);
  assert.equal(closed.status, "ok");
  assert.equal(closed.turns, 1);
  assert.equal(closed.okCount, 1);
  assert.deepEqual(closed.usage, { input: 300, output: 45 });
  assert.equal(closed.endedAt, 2500);
  assert.deepEqual(ledger.settle(h.runId), closed, "idempotent");
});

test("usage: provider shapes normalize; absent usage stays null (never guessed)", () => {
  // 切片②起细分三键随形状归一（absent → null 诚实空缺）——钉子跟契约形状走。
  const withSub = (i, o) => ({ input: i, output: o, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
  assert.deepEqual(normalizeUsage({ input: 1, output: 2 }), withSub(1, 2));
  assert.deepEqual(normalizeUsage({ inputTokens: 1, outputTokens: 2 }), withSub(1, 2));
  assert.deepEqual(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2 }), withSub(1, 2));
  assert.deepEqual(
    normalizeUsage({ input: 1, output: 2, cacheReadTokens: 5, reasoningTokens: 3 }),
    { input: 1, output: 2, cacheReadTokens: 5, cacheWriteTokens: null, reasoningTokens: 3 },
  );
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({ model: "m" }), null);
  fixtureFleet(fleetDb, { members: [member("m_up")] });
  const ev = recordTurnEvent(fleetDb, rootJob("f_run", "m_up"), { ok: true }, { startedAt: 1, endedAt: 2 });
  assert.equal(ev.usage, null);
});

// ── 3. chain through the seam ───────────────────────────────────────────────

test("seam: handoff → fanout three hops read as one tree under one runId; header closes with 4 turns", async () => {
  fixtureFleet(fleetDb, {
    members: [member("m_up"), member("m_mid"), member("m_a"), member("m_b")],
    orchestration: {
      mode: "pipeline",
      edges: [
        { kind: "handoff", from: "m_up", to: "m_mid" },
        { kind: "fanout", from: "m_mid", targets: ["m_a", "m_b"], aggregate: { kind: "all" } },
      ],
    },
  });
  const ctx = buildCtx(fleetDb);
  await ctx.runCronJobTurn(rootJob("f_run", "m_up", "j_root"));
  await engine.idle();
  await new Promise((r) => setTimeout(r, 20));
  await engine.idle();

  const runs = fleetDb.listRuns("f_run").runs;
  assert.equal(runs.length, 1, "one run for the whole chain");
  const run = runs[0];
  const turns = fleetDb.listRunTurns(run.runId);
  assert.equal(turns.length, 4);
  const byMember = Object.fromEntries(turns.map((t) => [t.memberId, t]));
  assert.equal(byMember.m_up.parentTurnId, null);
  assert.equal(byMember.m_mid.parentTurnId, byMember.m_up.turnId);
  assert.equal(byMember.m_mid.edgeKind, "handoff");
  assert.equal(byMember.m_a.parentTurnId, byMember.m_mid.turnId);
  assert.equal(byMember.m_a.edgeKind, "fanout");
  assert.equal(byMember.m_b.parentTurnId, byMember.m_mid.turnId);
  assert.ok(turns.every((t) => t.runId === run.runId));
  assert.equal(run.status, "ok");
  assert.equal(run.turns, 4);
  assert.deepEqual(run.usage, { input: 400, output: 80 });
  assert.equal(ctx.fleetTurnLedger.openTurns().length, 0);
});

test("seam: a mid-turn dispatch found by post inherits the run with edgeKind=dispatch", async () => {
  fixtureFleet(fleetDb, { members: [member("m_up"), member("m_exec")] });
  const sent = [];
  let ctx;
  ctx = buildCtx(fleetDb, {
    broadcast: (m) => sent.push(m),
    runPersona: async (_c, job) => {
      // The dispatch route's shape: attribution is post-level, so the chain
      // comes from the dispatcher post's in-flight turn.
      if (job.sourceTag?.memberId === "m_up") {
        const upstream = ctx.fleetTurnLedger.lookupByMember("m_up");
        const chain = ctx.fleetTurnLedger.chainFor(upstream, "dispatch");
        engine.createManualTask({ prompt: "派发", persona: "p-m_exec", initiator: job.sessionId, origin: { fleet: { fleetId: "f_run", memberId: "m_exec", depth: 1, chain } } });
      }
      return { ok: true, text: "派了" };
    },
  });
  await ctx.runCronJobTurn(rootJob("f_run", "m_up", "j_disp"));
  await engine.idle();
  await new Promise((r) => setTimeout(r, 20));
  await engine.idle();
  const [run] = fleetDb.listRuns("f_run").runs;
  const turns = fleetDb.listRunTurns(run.runId);
  assert.equal(turns.length, 2);
  const exec = turns.find((t) => t.memberId === "m_exec");
  const up = turns.find((t) => t.memberId === "m_up");
  assert.equal(exec.edgeKind, "dispatch");
  assert.equal(exec.parentTurnId, up.turnId);
  assert.equal(exec.source, "delegation");
  assert.equal(run.status, "ok");
  assert.equal(run.turns, 2);
  // The dispatch happened while the upstream turn was still open, so the
  // downstream's started event carries the parent POST for edge lighting.
  const execStarted = sent.find((m) => m.type === "fleet_turn_started" && m.memberId === "m_exec");
  assert.equal(execStarted.parentMemberId, "m_up");
});

test("seam: non-fleet dispatcher (no in-flight turn) → chain null, target starts a root run honestly", async () => {
  fixtureFleet(fleetDb, { members: [member("m_exec")] });
  const ctx = buildCtx(fleetDb);
  const chain = ctx.fleetTurnLedger.chainFor(ctx.fleetTurnLedger.lookupByMember("m_nobody"), "dispatch");
  assert.equal(chain, null);
  engine.createManualTask({ prompt: "派发", persona: "p-m_exec", origin: { fleet: { fleetId: "f_run", memberId: "m_exec", depth: 1 } } });
  await engine.idle();
  const [run] = fleetDb.listRuns("f_run").runs;
  assert.equal(run.rootMemberId, "m_exec");
  assert.equal(run.rootSource, "manual");
  assert.equal(run.turns, 1);
});

// ── 4. settle semantics ─────────────────────────────────────────────────────

test("settle: stays open while a chained task is queued or in flight; excludes the ending task itself", () => {
  fixtureFleet(fleetDb, { members: [member("m_up"), member("m_down")] });
  const records = [];
  const ledger = createFleetTurnLedger({ db: fleetDb, engineRecords: () => records });
  const job = rootJob("f_run", "m_up", "j_s");
  const h = ledger.begin(job, { startedAt: 1 });
  assert.equal(ledger.settle(h.runId), null, "turn still open");
  ledger.end(job, h, { ok: true }, { startedAt: 1, endedAt: 2 });
  records.push({ id: "j_s", state: "running", origin: { fleet: { fleetId: "f_run", memberId: "m_up", chain: { runId: h.runId } } } });
  records.push({ id: "t_down", state: "queued", origin: { fleet: { fleetId: "f_run", memberId: "m_down", chain: { runId: h.runId, parentTurnId: h.turnId, edgeKind: "handoff" } } } });
  assert.equal(ledger.settle(h.runId, { excludeTaskId: "j_s" }), null, "queued downstream keeps it open");
  records[1].state = "done";
  assert.equal(ledger.settle(h.runId, { excludeTaskId: "j_s" })?.status, "ok", "own running record is excluded");
});

test("settle: a late downstream re-opens a closed run and re-closes with consistent totals", () => {
  fixtureFleet(fleetDb, { members: [member("m_up"), member("m_down")] });
  const ledger = createFleetTurnLedger({ db: fleetDb });
  const job = rootJob("f_run", "m_up", "j_late");
  const h = ledger.begin(job, { startedAt: 1 });
  // text 不能省：只有 usage、没有文本/工具/报数的回合会被 fix-stub-turn-success 判成
  // 桩回合（interrupted），这一轮就 settle 成 partial 而不是 ok。这条用例要的是结算
  // 投影（turns/okCount/failedCount/endedAt），不是桩判据。
  ledger.end(job, h, { ok: true, text: "已派发。", usage: { input: 10, output: 1 } }, { startedAt: 1, endedAt: 2 });
  assert.equal(ledger.settle(h.runId).status, "ok");
  const late = { id: "t_late", trigger: "manual", preset: "p-m_down", sessionId: "task-t_late", origin: { fleet: { fleetId: "f_run", memberId: "m_down", depth: 1, chain: { runId: h.runId, parentTurnId: h.turnId, edgeKind: "handoff" } } } };
  const h2 = ledger.begin(late, { startedAt: 10 });
  assert.equal(h2.runId, h.runId);
  assert.equal(fleetDb.getRun(h.runId).status, "open", "re-opened");
  ledger.end(late, h2, { ok: false, error: "503 upstream" }, { startedAt: 10, endedAt: 12 });
  const closed = ledger.settle(h.runId);
  assert.equal(closed.status, "partial");
  assert.equal(closed.turns, 2);
  assert.equal(closed.okCount, 1);
  assert.equal(closed.failedCount, 1);
  assert.equal(closed.endedAt, 12);
  assert.deepEqual(closed.usage, { input: 10, output: 1 });
});

// ── 5. broadcasts ───────────────────────────────────────────────────────────

test("broadcasts: open → started → ended → closed, fleet-domain fields only", async () => {
  fixtureFleet(fleetDb, { members: [member("m_up")] });
  const sent = [];
  const ctx = buildCtx(fleetDb, { broadcast: (m) => sent.push(m) });
  await ctx.runCronJobTurn(rootJob("f_run", "m_up", "j_ws"));
  const types = sent.map((m) => m.type).filter((t) => t.startsWith("fleet_"));
  assert.deepEqual(types, ["fleet_run_updated", "fleet_turn_started", "fleet_turn_ended", "fleet_run_updated"]);
  const started = sent.find((m) => m.type === "fleet_turn_started");
  const ended = sent.find((m) => m.type === "fleet_turn_ended");
  const allowed = new Set(["type", "fleetId", "memberId", "runId", "turnId", "parentTurnId", "parentMemberId", "edgeKind", "source", "sessionId", "startedAt", "endedAt", "status", "errorKind", "model", "usage"]);
  for (const k of Object.keys(started)) assert.ok(allowed.has(k), `started leaks ${k}`);
  for (const k of Object.keys(ended)) assert.ok(allowed.has(k), `ended leaks ${k}`);
  assert.equal(ended.status, "ok");
  assert.deepEqual(ended.usage, { input: 100, output: 20 });
  const closed = sent.filter((m) => m.type === "fleet_run_updated").pop();
  assert.equal(closed.run.status, "ok");
  assert.equal(closed.run.turns, 1);
});

// ── 6. trace tap ────────────────────────────────────────────────────────────

test("trace tap: collectTurn feeds the trace store keyed by the ledger turn id under the mirror session", async () => {
  fixtureFleet(fleetDb, { members: [member("m_up")] });
  const trace = { records: [], bound: [], record(n, k) { this.records.push({ n, k }); }, bindTurn(id) { this.bound.push(id); } };
  const ctx = { sessionCollectors: new Map(), onRuntimeIdle: () => {} };
  ctx.fleetTurnLedger = createFleetTurnLedger({ db: fleetDb, trace });
  const job = rootJob("f_run", "m_up", "j_tap");
  const startedAt = 777;
  const child = roundChildSessionId(job, startedAt);
  assert.equal(child, `${job.sessionId}#r${startedAt}`);
  const h = ctx.fleetTurnLedger.begin(job, { startedAt, sessionIds: [child] });
  assert.equal(h.traceTurnId, h.turnId);
  assert.deepEqual(trace.bound, [h.turnId]);
  const active = new Map();
  const collected = collectTurn(ctx, child, 5000, active, ctx.sessionCollectors, job.sessionId);
  const collector = ctx.sessionCollectors.get(child);
  collector({ method: "session.event", params: { event: { type: "tool/call", data: { callId: "c1", name: "web_search", arguments: "{}" } } } });
  collector({ method: "session.status", params: { status: "idle" } });
  await collected;
  assert.equal(trace.records.length, 2);
  assert.equal(trace.records[0].k.turnId, h.turnId);
  assert.equal(trace.records[0].k.sessionId, job.sessionId, "rows land under the mirror session");
  assert.equal(trace.records[0].n.params.event.type, "tool/call");
  ctx.fleetTurnLedger.end(job, h, { ok: true }, { startedAt, endedAt: 800 });
  assert.equal(fleetDb.getTurnEvent(h.turnId).traceTurnId, h.turnId);
  // After the turn ends the key is gone: a stray notification records nothing.
  assert.equal(ctx.fleetTurnLedger.tap({ method: "session.status", params: {} }, child, job.sessionId), false);
});

test("trace tap: FLEET_TRACE_TAP=0 leaves traceTurnId null and records nothing", () => {
  const prev = process.env.FLEET_TRACE_TAP;
  process.env.FLEET_TRACE_TAP = "0";
  try {
    assert.equal(traceTapEnabled(), false);
    fixtureFleet(fleetDb, { members: [member("m_up")] });
    const trace = { records: [], record(n, k) { this.records.push({ n, k }); }, bindTurn() {} };
    const ledger = createFleetTurnLedger({ db: fleetDb, trace });
    const job = rootJob("f_run", "m_up", "j_off");
    const h = ledger.begin(job, { startedAt: 1, sessionIds: ["s#r1"] });
    assert.equal(h.traceTurnId, null);
    assert.equal(ledger.tap({ method: "session.status", params: {} }, "s#r1", "s"), false);
    assert.equal(trace.records.length, 0);
    const ev = ledger.end(job, h, { ok: true }, { startedAt: 1, endedAt: 2 });
    assert.equal(ev.traceTurnId, null);
  } finally {
    if (prev === undefined) delete process.env.FLEET_TRACE_TAP;
    else process.env.FLEET_TRACE_TAP = prev;
  }
});

// ── 7. retention ────────────────────────────────────────────────────────────

test("retention: dual condition — recent rows beyond N are kept, old rows beyond N are pruned", () => {
  const prevKeep = process.env.FLEET_TURN_EVENTS_KEEP;
  process.env.FLEET_TURN_EVENTS_KEEP = "2";
  try {
    fixtureFleet(fleetDb, { members: [member("m_r")] });
    const base = { fleetId: "f_run", memberId: "m_r", source: "cron", status: "ok" };
    const old = Date.now() - 40 * 86_400_000;
    for (let i = 0; i < 3; i++) fleetDb.appendTurnEvent({ ...base, startedAt: old + i, endedAt: old + i + 1 });
    assert.equal(fleetDb.listTurnEvents("m_r", { limit: 50 }).length, 2, "old beyond N → pruned, old within N → kept");
    const now = Date.now();
    for (let i = 0; i < 3; i++) fleetDb.appendTurnEvent({ ...base, startedAt: now + i, endedAt: now + i + 1 });
    const rows = fleetDb.listTurnEvents("m_r", { limit: 50 });
    assert.equal(rows.length, 3, "the 3 recent rows all stay (not past the window); the 2 old ones now fall beyond N → pruned");
    assert.ok(rows.every((r) => r.endedAt >= now));
  } finally {
    if (prevKeep === undefined) delete process.env.FLEET_TURN_EVENTS_KEEP;
    else process.env.FLEET_TURN_EVENTS_KEEP = prevKeep;
  }
});

test("retention: pruneRuns ages closed headers past the window, never open ones; orphans read without error", () => {
  fixtureFleet(fleetDb, { members: [member("m_up")] });
  const ledger = createFleetTurnLedger({ db: fleetDb });
  const old = Date.now() - 40 * 86_400_000;
  const job = rootJob("f_run", "m_up", "j_old");
  const h = ledger.begin(job, { startedAt: old });
  ledger.end(job, h, { ok: true }, { startedAt: old, endedAt: old + 5 });
  ledger.settle(h.runId);
  const h2 = ledger.begin(rootJob("f_run", "m_up", "j_open"), { startedAt: Date.now() });
  const swept = fleetDb.pruneRuns();
  assert.equal(swept.runs, 1, "the closed old header is gone");
  assert.equal(fleetDb.getRun(h.runId), null);
  assert.equal(fleetDb.getRun(h2.runId).status, "open", "open header survives");
  // The old turn row is within the member's newest-N floor → kept as an orphan;
  // the member timeline still reads it, the run list does not show its run.
  assert.equal(fleetDb.getTurnEvent(h.turnId)?.runId, h.runId);
  assert.ok(!fleetDb.listRuns("f_run").runs.some((r) => r.runId === h.runId));
});

// ── 8. read face helpers ────────────────────────────────────────────────────

test("listRuns filters by status/source/window with paging; edgeTraffic groups hops per 24h", async () => {
  fixtureFleet(fleetDb, {
    members: [member("m_up"), member("m_down")],
    orchestration: { mode: "pipeline", edges: [{ kind: "handoff", from: "m_up", to: "m_down" }] },
  });
  const ctx = buildCtx(fleetDb);
  await ctx.runCronJobTurn(rootJob("f_run", "m_up", "j_a"));
  await engine.idle();
  await new Promise((r) => setTimeout(r, 20));
  await engine.idle();
  // a second, failed root run (no chain) via the recorder path
  const ledger = ctx.fleetTurnLedger;
  const jb = { ...rootJob("f_run", "m_up", "j_b"), trigger: "manual", sourceTag: undefined, origin: { fleet: { fleetId: "f_run", memberId: "m_up", depth: 0 } } };
  const hb = ledger.begin(jb, { startedAt: Date.now() });
  ledger.end(jb, hb, { ok: false, error: "timeout" }, { startedAt: hb.startedAt, endedAt: hb.startedAt + 1 });
  ledger.settle(hb.runId);

  assert.equal(fleetDb.listRuns("f_run").total, 2);
  assert.equal(fleetDb.listRuns("f_run", { status: "failed" }).runs[0].runId, hb.runId);
  assert.equal(fleetDb.listRuns("f_run", { source: "cron" }).total, 1);
  assert.equal(fleetDb.listRuns("f_run", { since: Date.now() + 10_000 }).total, 0);
  assert.equal(fleetDb.listRuns("f_run", { limit: 1 }).runs.length, 1);
  assert.equal(fleetDb.listRuns("f_run", { limit: 1, offset: 1 }).runs.length, 1);

  const traffic = fleetDb.edgeTraffic("f_run");
  assert.deepEqual(traffic.map((t) => [t.from, t.to, t.kind, t.turns, t.ok]), [["m_up", "m_down", "handoff", 1, 1]]);
  assert.equal(buildTurnRequest(engine.allRecords().find((t) => t.origin?.fleet?.memberId === "m_down")).chain.edgeKind, "handoff");
});

// ── 9. run read face (routes) ───────────────────────────────────────────────

  async function startRoutesServer(_db, ctxOver = {}) {
  const express = (await import("express")).default;
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }), ...ctxOver });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("routes: runs list filters by status/source/window, pages, and carries titles + duration", async () => {
  fixtureFleet(fleetDb, {
    members: [member("m_up", "上游岗"), member("m_down", "下游岗")],
    orchestration: { mode: "pipeline", edges: [{ kind: "handoff", from: "m_up", to: "m_down" }] },
  });
  const ctx = buildCtx(fleetDb);
  await ctx.runCronJobTurn(rootJob("f_run", "m_up", "j_ok"));
  await engine.idle();
  await new Promise((r) => setTimeout(r, 20));
  await engine.idle();
  const ledger = ctx.fleetTurnLedger;
  const jb = { id: "j_b", trigger: "manual", targetType: "persona", preset: "p-m_up", sessionId: "task-j_b", origin: { fleet: { fleetId: "f_run", memberId: "m_up", depth: 0 } } };
  const hb = ledger.begin(jb, { startedAt: Date.now() });
  ledger.end(jb, hb, { ok: false, error: "boom" }, { startedAt: hb.startedAt, endedAt: hb.startedAt + 9 });
  ledger.settle(hb.runId);

  const { server, base } = await startRoutesServer(fleetDb);
  const get = async (q) => (await fetch(`${base}/api/fleets/f_run/runs${q}`)).json();
  try {
    const all = await get("");
    assert.equal(all.total, 2);
    const okRun = all.runs.find((r) => r.status === "ok");
    assert.equal(okRun.rootMemberTitle, "上游岗");
    assert.equal(okRun.turns, 2);
    assert.ok(Number.isFinite(okRun.durationMs) && okRun.durationMs >= 0);
    assert.deepEqual(okRun.usage, { input: 200, output: 40 });
    assert.equal((await get("?status=failed")).runs[0].runId, hb.runId);
    assert.equal((await get("?source=cron")).total, 1);
    assert.equal((await get("?since=1970&until=1000")).total, 0);
    assert.equal((await get("?limit=1&offset=1")).runs.length, 1);
    assert.equal((await get("?status=weird")).error.includes("open|ok|failed|partial"), true);
    assert.equal((await get("?since=yesterday")).error.includes("epoch"), true);
  } finally {
    server.close();
  }
});

test("routes: run detail orders turns and reconstructs the chain; ownership rules match the fleet face", async () => {
  fixtureFleet(fleetDb, {
    members: [member("m_up", "上游岗"), member("m_down", "下游岗")],
    orchestration: { mode: "pipeline", edges: [{ kind: "handoff", from: "m_up", to: "m_down" }] },
  });
  const ctx = buildCtx(fleetDb);
  await ctx.runCronJobTurn(rootJob("f_run", "m_up", "j_det"));
  await engine.idle();
  await new Promise((r) => setTimeout(r, 20));
  await engine.idle();
  const [run] = fleetDb.listRuns("f_run").runs;

  const { server, base } = await startRoutesServer(fleetDb);
  try {
    const r = await fetch(`${base}/api/fleets/f_run/runs/${run.runId}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.turns.length, 2);
    const [up, down] = body.turns;
    assert.ok(up.startedAt <= down.startedAt, "ordered by start");
    assert.equal(down.parentTurnId, up.turnId);
    assert.equal(down.edgeKind, "handoff");
    assert.deepEqual(down.usage, { input: 100, output: 20 });
    assert.ok(down.traceTurnId || down.traceTurnId === null);
    // 404 after ownership passes; a foreign fleet's run is invisible either way
    assert.equal((await fetch(`${base}/api/fleets/f_run/runs/run_nope`)).status, 404);
    // non-owner email → same rule as every fleet read (403, no existence leak)
    assert.equal((await fetch(`${base}/api/fleets/f_run/runs/${run.runId}`, { headers: {} })).status, 200);
    const other = await startRoutesServer(fleetDb, { cellUserEmail: "stranger@test" });
    try {
      assert.equal((await fetch(`${other.base}/api/fleets/f_run/runs/${run.runId}`)).status, 403);
      assert.equal((await fetch(`${other.base}/api/fleets/f_run/runs/run_nope`)).status, 403, "403 before 404 — no existence leak");
    } finally {
      other.server.close();
    }
  } finally {
    server.close();
  }
});

test("routes: cockpit carries edgeTraffic with the 24h hop split", async () => {
  fixtureFleet(fleetDb, {
    members: [member("m_up", "上游岗"), member("m_down", "下游岗")],
    orchestration: { mode: "pipeline", edges: [{ kind: "handoff", from: "m_up", to: "m_down" }] },
  });
  const ctx = buildCtx(fleetDb);
  await ctx.runCronJobTurn(rootJob("f_run", "m_up", "j_traffic"));
  await engine.idle();
  await new Promise((r) => setTimeout(r, 20));
  await engine.idle();
  const { server, base } = await startRoutesServer(fleetDb, { currentPreset: "p-m_up" });
  try {
    const body = await (await fetch(`${base}/api/fleets/f_run/cockpit`)).json();
    assert.deepEqual(
      body.edgeTraffic.map((t) => [t.from, t.to, t.kind, t.turns, t.ok, t.failed]),
      [["m_up", "m_down", "handoff", 1, 1, 0]],
    );
  } finally {
    server.close();
  }
});

// ── 10. settle backstop via engine addOnFinished (prod leak, 2026-10-26) ────

test("backstop: a chained task that dies at the ENGINE layer (never enters the seam) still closes the run header", () => {
  fixtureFleet(fleetDb, { members: [member("m_up"), member("m_exec")] });
  const ledger = createFleetTurnLedger({ db: fleetDb, engineRecords: () => engine.allRecords() });
  const job = rootJob("f_run", "m_up", "j_backstop");
  const h = ledger.begin(job, { startedAt: 1 });
  // The upstream turn ends and queues a chained dispatch task…
  ledger.end(job, h, { ok: true }, { startedAt: 1, endedAt: 2 });
  engine.createManualTask({
    prompt: "派发",
    persona: "p-m_exec",
    origin: { fleet: { fleetId: "f_run", memberId: "m_exec", depth: 1, chain: { runId: h.runId, parentTurnId: h.turnId, edgeKind: "dispatch" } } },
  });
  const chained = engine.allRecords().find((t) => t.origin?.fleet?.chain?.runId === h.runId);
  assert.ok(chained, "chained task exists");
  // While the chained task is queued/running, the seam settle keeps it open.
  chained.state = "queued";
  assert.equal(ledger.settle(h.runId, { excludeTaskId: job.id }), null, "queued downstream keeps the header open");
  // The task then dies at the ENGINE layer WITHOUT ever entering the turn seam
  // (schedule-side failure): terminal record, no turn row, no seam settle.
  // The engine's on-finished hook (server wiring) re-runs settle — and now
  // with every chained record terminal, the header closes honestly.
  chained.state = "failed";
  const finished = ledger.settle(chained.origin.fleet.chain.runId, { excludeTaskId: chained.id });
  assert.equal(finished.status, "ok");
  assert.equal(finished.turns, 1, "only the upstream turn row exists — the engine-layer death is honest absence");
  assert.equal(fleetDb.getRun(h.runId).status, "ok");
});

// ── 11. trace fleet annotation (add-cockpit-ux-polish) ──────────────────────

test("annotateFleetTurns: hits get post attribution, misses stay untouched", async () => {
  const { annotateFleetTurns } = await import("../server/routes/trace.js");
  const rows = [
    { trace_turn_id: "turn_hit1", fleet_id: "f1", member_id: "m_ceo", member_title: "CEO" },
    { trace_turn_id: "turn_hit2", fleet_id: "f1", member_id: "m_gone", member_title: null },
  ];
  const turns = [
    { turnId: "turn_hit1", sessionId: "s1" },
    { turnId: "turn_web", sessionId: "live-1" },
    { turnId: "turn_hit2", sessionId: "s2" },
  ];
  const out = annotateFleetTurns(turns, rows);
  assert.deepEqual(out[0].fleet, { fleetId: "f1", memberId: "m_ceo", memberTitle: "CEO" });
  assert.equal(out[1].fleet, undefined, "web turns carry no fleet attribution");
  assert.deepEqual(out[2].fleet, { fleetId: "f1", memberId: "m_gone", memberTitle: null }, "deleted post keeps ids, title null");
  // pure: input rows untouched
  assert.equal(turns[0].fleet, undefined);
});

// ── 12. orphan-open reclaim (add-cockpit-run-reclaim) ──────────────────────

test("orphan sweep: a header whose turn never wrote a row is closed past grace; a live one is untouched", () => {
  fixtureFleet(fleetDb, { members: [member("m_up")] });
  const ledger = createFleetTurnLedger({ db: fleetDb });
  const stale = ledger.begin(rootJob("f_run", "m_up", "j_gone"), { startedAt: Date.now() - 3 * 3600_000 });
  const live = ledger.begin(rootJob("f_run", "m_up", "j_live"), { startedAt: Date.now() });
  assert.equal(fleetDb.getRun(stale.runId).status, "open");
  assert.equal(fleetDb.reclaimOrphanRuns(), 1, "only the stale zero-turn header is reclaimed");
  const gone = fleetDb.getRun(stale.runId);
  assert.equal(gone.status, "failed");
  assert.equal(gone.turns, 0);
  assert.equal(gone.endedAt, stale.startedAt, "closed at its own start — nothing ever happened");
  assert.equal(fleetDb.getRun(live.runId).status, "open", "in-flight stays open");
  // A run WITH turn rows is never reclaimed by this sweep (settle owns it).
  const withTurn = ledger.begin(rootJob("f_run", "m_up", "j_turn"), { startedAt: Date.now() - 3 * 3600_000 });
  fleetDb.appendTurnEvent({ fleetId: "f_run", memberId: "m_up", source: "cron", status: "ok", startedAt: 1, endedAt: 2, runId: withTurn.runId, turnId: withTurn.turnId });
  assert.equal(fleetDb.reclaimOrphanRuns(), 0, "a run with rows is not an orphan");
});

// ── 13. leaked-header settle (fix-fleet-run-header-settle) ──────────────────

test("leaked header: a run whose turn finished but never settled is closed by the ledger sweep; a live one is not", () => {
  fixtureFleet(fleetDb, { members: [member("m_up")] });
  // The prod shape is a POD ROLL: the ledger that opened the header is gone,
  // and a fresh process (empty handle map, empty engine) sweeps the DB. So the
  // headers are opened by `before` and swept by `after`.
  const before = createFleetTurnLedger({ db: fleetDb, engineRecords: () => [] });
  const after = createFleetTurnLedger({ db: fleetDb, engineRecords: () => [] });

  // A run whose turn row landed but whose settle never ran.
  const leaked = before.begin(rootJob("f_run", "m_up", "j_leak"), { startedAt: Date.now() - 3 * 3600_000 });
  fleetDb.appendTurnEvent({
    fleetId: "f_run", memberId: "m_up", source: "cron", status: "ok",
    startedAt: leaked.startedAt, endedAt: leaked.startedAt + 1000,
    runId: leaked.runId, turnId: leaked.turnId,
  });
  assert.equal(fleetDb.getRun(leaked.runId).status, "open", "still open before the sweep");
  assert.equal(after.sweepOpenRuns(), 1, "the leaked header is closed by the new process");
  const closed = fleetDb.getRun(leaked.runId);
  assert.equal(closed.status, "ok", "closed from the rows, not as a failure");
  assert.equal(closed.turns, 1);
  assert.ok(closed.endedAt >= leaked.startedAt);

  // A header whose turn is still IN FLIGHT in the sweeping ledger is left
  // alone — that is the "chain waiting to hand off" case.
  const inflight = after.begin(rootJob("f_run", "m_up", "j_fly"), { startedAt: Date.now() - 3 * 3600_000 });
  fleetDb.appendTurnEvent({
    fleetId: "f_run", memberId: "m_up", source: "cron", status: "ok",
    startedAt: inflight.startedAt, endedAt: inflight.startedAt + 1000,
    runId: inflight.runId, turnId: inflight.turnId,
  });
  assert.equal(after.sweepOpenRuns(), 0, "a run with an in-flight turn is not swept");
  assert.equal(fleetDb.getRun(inflight.runId).status, "open");

  // A header younger than the grace window is not swept either.
  const fresh = before.begin(rootJob("f_run", "m_up", "j_fresh"), { startedAt: Date.now() - 60_000 });
  fleetDb.appendTurnEvent({
    fleetId: "f_run", memberId: "m_up", source: "cron", status: "ok",
    startedAt: fresh.startedAt, endedAt: fresh.startedAt + 1000,
    runId: fresh.runId, turnId: fresh.turnId,
  });
  assert.equal(after.sweepOpenRuns(), 0, "a recent header is not swept");
  assert.equal(fleetDb.getRun(fresh.runId).status, "open");

  // A zero-row header stays open here — the DB-level orphan sweep owns that
  // verdict (it closes it as failed); the ledger must not second-guess it.
  const zeroRow = before.begin(rootJob("f_run", "m_up", "j_zero"), { startedAt: Date.now() - 3 * 3600_000 });
  assert.equal(after.sweepOpenRuns(), 0, "a zero-row header is left to the orphan sweep");
  assert.equal(fleetDb.getRun(zeroRow.runId).status, "open");
  // …and the orphan sweep does close it, at its own start, as failed.
  assert.equal(fleetDb.reclaimOrphanRuns(), 1);
  assert.equal(fleetDb.getRun(zeroRow.runId).status, "failed");
});

// ── interrupted-beat catch-up (add-rollout-gap-durability) ──────────────────

// A cron-sourced run the pod roll killed: the beat was consumed at fire time
// (lastRun stamped), so the boot downtime pass never sees the gap. The sweep
// settles the leaked run and hands the decision to makeUpInterruptedBeat —
// same tolerance rule, same engine fire path.
async function cadenceTask(memberId) {
  const rec = await cron.addJob({ cron: "*/5 * * * *", prompt: "p", preset: `p-${memberId}`, sessionTitle: "t", sourceTag: { fleetId: "f_run", memberId } });
  // The live record — addJob's return is a clientShape copy, and lastRun must
  // land on the record the decision actually reads.
  const live = engine.getRecord(rec.id);
  live.lastRun = new Date().toISOString(); // the beat fired just now
  return live;
}

test("interrupted cron run inside tolerance → sweep settles it and fires ONE makeup", async () => {
  fixtureFleet(fleetDb, { members: [member("m_mk")] });
  const task = await cadenceTask("m_mk");
  // The killed beat: a run opened by the cron turn, its row written (the turn
  // started), the header never settled (process died).
  const killer = createFleetTurnLedger({ db: fleetDb });
  const job = rootJob("f_run", "m_mk");
  const h = killer.begin(job, { startedAt: Date.now() - 60_000 });
  killer.end(job, h, { ok: false, error: "killed by rollout" }, { startedAt: Date.now() - 60_000, endedAt: Date.now() - 59_000 });

  const verdicts = [];
  const sweeper = createFleetTurnLedger({
    db: fleetDb,
    engineRecords: () => engine.allRecords(),
    onInterruptedRun: ({ fleetId, memberId }) => {
      const v = cron.makeUpInterruptedBeat({ fleetId, memberId });
      verdicts.push(v);
      return v;
    },
  });
  const settled = sweeper.sweepOpenRuns({ now: Date.now(), graceMs: 0 });
  assert.equal(settled, 1, "the leaked header settled");
  assert.deepEqual(verdicts, ["makeup"]);
  assert.equal(task.catchUpPending, true, "the makeup rides the same engine marker");
});

test("interrupted cron run outside tolerance → honest no-makeup verdict", async () => {
  fixtureFleet(fleetDb, { members: [member("m_old")] });
  const task = await cadenceTask("m_old");
  task.lastRun = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // beat fired 10 days ago
  const killer = createFleetTurnLedger({ db: fleetDb });
  const job = rootJob("f_run", "m_old");
  const h = killer.begin(job, { startedAt: Date.now() - 60_000 });
  killer.end(job, h, { ok: false, error: "killed by rollout" }, { startedAt: Date.now() - 60_000, endedAt: Date.now() - 59_000 });

  const sweeper = createFleetTurnLedger({
    db: fleetDb,
    engineRecords: () => engine.allRecords(),
    onInterruptedRun: ({ fleetId, memberId }) => cron.makeUpInterruptedBeat({ fleetId, memberId }),
  });
  sweeper.sweepOpenRuns({ now: Date.now(), graceMs: 0 });
  assert.equal(task.catchUpPending, undefined, "no makeup past the tolerance window");
});

test("makeup decision: no task / paused / kill-switch verdicts", async () => {
  assert.equal(cron.makeUpInterruptedBeat({ fleetId: "f_run", memberId: "m_none" }), "no-task");
  fixtureFleet(fleetDb, { members: [member("m_paused")] });
  const task = await cadenceTask("m_paused");
  await cron.pauseJob(task.id);
  assert.equal(cron.makeUpInterruptedBeat({ fleetId: "f_run", memberId: "m_paused" }), "no-task", "a paused post gets no beat");
  await cron.resumeJob(task.id);
  process.env.PLATFORM_CRON_CATCHUP = "0";
  assert.equal(cron.makeUpInterruptedBeat({ fleetId: "f_run", memberId: "m_paused" }), "kill-switch");
  delete process.env.PLATFORM_CRON_CATCHUP;
  assert.equal(cron.makeUpInterruptedBeat({ fleetId: "f_run", memberId: "m_paused" }), "makeup", "kill switch released");
});

test("sweep ignores non-cron runs — manual/event runs have no cadence beat to consume", async () => {
  fixtureFleet(fleetDb, { members: [member("m_man")] });
  await cadenceTask("m_man");
  const killer = createFleetTurnLedger({ db: fleetDb });
  const job = { ...rootJob("f_run", "m_man"), trigger: "manual", source: "manual" };
  const h = killer.begin(job, { startedAt: Date.now() - 60_000 });
  killer.end(job, h, { ok: false }, { startedAt: Date.now() - 60_000, endedAt: Date.now() - 59_000 });
  // Force the row's root_source to manual the way a manual ignition does.
  fleetDb.db.prepare("UPDATE fleet_runs SET root_source = 'manual' WHERE run_id = ?").run(h.runId);

  const verdicts = [];
  const sweeper = createFleetTurnLedger({
    db: fleetDb,
    engineRecords: () => engine.allRecords(),
    onInterruptedRun: ({ fleetId, memberId }) => {
      verdicts.push(cron.makeUpInterruptedBeat({ fleetId, memberId }));
      return "makeup";
    },
  });
  sweeper.sweepOpenRuns({ now: Date.now(), graceMs: 0 });
  assert.deepEqual(verdicts, [], "the hook never fires for a non-cron run");
  assert.equal(engine.allRecords().find((t) => t?.sourceTag?.memberId === "m_man")?.catchUpPending, undefined);
});
