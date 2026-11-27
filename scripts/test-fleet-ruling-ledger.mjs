// Ruling-turn ledger (add-fleet-ruling-ledger).
//
// The summary / judge turn is the ONE fleet turn that never went through the
// task engine — the aggregator prompts the initiating session directly. So it
// had no O1 row, no run header, no chain: invisible on the canvas, absent from
// cost, and structurally unable to be the parent of a next debate wave.
//
// This pins the identity derivation and the ledger node it now opens. The
// prompt paths themselves are exercised by the persona-park lane suite.
//
// Run: node --test scripts/test-fleet-ruling-ledger.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ruling-ledger-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { rulingTurnIdentity, rulingTurnJob } = await import("../server/delegation-aggregator.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createFleetTurnLedger } = await import("../server/fleet-runs.js");

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

const fleet = fleetDb.createFleet({ id: "f_r", name: "编导舰", ownerEmail: "owner@test" });
for (const id of ["r_up", "r_w1", "r_judge"]) {
  fleetDb.createMember({ id, fleetId: fleet.id, title: id, targetKind: "persona", targetId: `p-${id}`, kpiSlots: [], cadence: null });
}

const chain = { runId: "run_r", parentTurnId: "turn_up", edgeKind: "fanout" };
// The chain is a NESTED object on origin.fleet (that is what withChain writes);
// spreading it flat would test a shape production never produces.
const hop = (over = {}) => ({
  id: "t_w1",
  state: "done",
  initiator: "sess-up",
  initiatorPreset: "p-r_up",
  origin: { fleet: { fleetId: fleet.id, memberId: "r_w1", byMemberId: "r_up", ignition: "k1", chain } },
  ...over,
});

test("identity: a judge wave carries fleet+judge in its synthetic initiator", () => {
  const who = rulingTurnIdentity([hop({ initiator: "fleet:f_r:r_judge" })], "fleet:f_r:r_judge");
  assert.deepEqual(who, { fleetId: "f_r", memberId: "r_judge" });
});

test("identity: a no-judge wave resolves to the post that ignited it (byMemberId)", () => {
  const who = rulingTurnIdentity([hop()], "sess-up");
  assert.deepEqual(who, { fleetId: "f_r", memberId: "r_up" }, "the upstream post, not the target");
});

test("identity: no evidence → no ledger row (old behaviour, never a guess)", () => {
  const bare = { id: "t_x", state: "done", initiator: "sess-up", origin: {} };
  assert.equal(rulingTurnIdentity([bare], "sess-up"), null);
  assert.equal(rulingTurnJob({ group: [bare], initiator: "sess-up" }), null);
  // A hop with a fleet but no byMemberId (pre-fix row) is also refused.
  const legacy = { id: "t_y", state: "done", origin: { fleet: { fleetId: "f_r", memberId: "r_w1" } } };
  assert.equal(rulingTurnIdentity([legacy], "sess-x"), null);
});

test("job shape: joins the wave's run and chains under the wave's parent turn", () => {
  const job = rulingTurnJob({ group: [hop()], initiator: "sess-up" });
  assert.equal(job.sourceTag.fleetId, "f_r");
  assert.equal(job.sourceTag.memberId, "r_up");
  assert.equal(job.sessionId, "sess-up");
  assert.equal(job.initiator, "sess-up");
  assert.deepEqual(job.origin.fleet.chain, chain, "run + parent turn + edge kind ride the synthetic job");
});

test("ledger: the ruling turn lands as a real node of the same run, then the run settles", () => {
  const ledger = createFleetTurnLedger({ db: fleetDb, engineRecords: () => [] });
  fleetDb.insertRun({ runId: "run_r", fleetId: fleet.id, rootSource: "schedule", rootMemberId: "r_up", startedAt: Date.now() - 60_000 });
  fleetDb.appendTurnEvent({
    fleetId: fleet.id,
    memberId: "r_up",
    runId: "run_r",
    turnId: "turn_up",
    source: "schedule",
    status: "ok",
    startedAt: Date.now() - 60_000,
    endedAt: Date.now() - 30_000,
    usage: { input: 100, output: 20 },
  });

  const job = rulingTurnJob({ group: [hop()], initiator: "sess-up" });
  const handle = ledger.begin(job, { startedAt: Date.now(), sessionIds: ["sess-up"] });
  assert.ok(handle, "the ruling turn gets a handle");
  assert.equal(handle.runId, "run_r", "it joins the wave's run — no new header");
  assert.equal(handle.parentTurnId, "turn_up", "chained under the wave's parent turn");
  assert.equal(handle.edgeKind, "fanout");
  assert.equal(handle.memberId, "r_up", "attributed to the post that speaks the ruling");

  ledger.end(
    job,
    handle,
    { ok: true, text: "裁决完成", usage: { input: 300, output: 40 } },
    { startedAt: handle.startedAt, endedAt: Date.now(), model: null },
  );

  const rows = fleetDb.listRunTurns("run_r");
  const ruling = rows.find((r) => r.turnId === handle.turnId);
  assert.ok(ruling, "the ruling turn is an O1 row of the run");
  assert.equal(ruling.memberId, "r_up");
  assert.equal(ruling.parentTurnId, "turn_up");
  assert.equal(ruling.edgeKind, "fanout");
  assert.equal(ruling.source, "delegation", "the delegation lane, honestly (initiator present)");
  assert.equal(ruling.status, "ok");
  assert.equal(ruling.usage.input, 300, "its tokens count");

  const settled = ledger.settle("run_r");
  assert.ok(settled, "nothing is left in flight");
  assert.equal(settled.turns, 2, "root turn + ruling turn");
  assert.equal(settled.status, "ok");
});

test("ledger: a failed ruling turn lands as failed, not as a silent no-row", () => {
  const ledger = createFleetTurnLedger({ db: fleetDb, engineRecords: () => [] });
  fleetDb.insertRun({ runId: "run_r2", fleetId: fleet.id, rootSource: "schedule", rootMemberId: "r_up", startedAt: Date.now() - 60_000 });
  const job = rulingTurnJob({
    group: [hop({ origin: { fleet: { fleetId: fleet.id, memberId: "r_w1", byMemberId: "r_up", chain: { ...chain, runId: "run_r2" } } } })],
    initiator: "sess-up",
  });
  const handle = ledger.begin(job, { startedAt: Date.now(), sessionIds: ["sess-up"] });
  ledger.end(job, handle, { ok: false, error: "runtime went away" }, { startedAt: handle.startedAt, endedAt: Date.now(), model: null });
  const ruling = fleetDb.listRunTurns("run_r2").find((r) => r.turnId === handle.turnId);
  assert.ok(ruling, "the failed ruling turn is still a row");
  assert.equal(ruling.status, "failed");
  assert.match(ruling.error, /runtime went away/);
});

test.after(() => {
  try { fleetDb.close(); } catch { /* shared handle */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── the wiring, not just the helper ─────────────────────────────────────────
//
// The helper tests above would pass even if runInjection ignored the result —
// which is exactly what a well-meaning refactor could do. This drives the REAL
// aggregate path (attachDelegationAggregator → chainTurn → runInjection) with a
// minimal ctx and asserts the ruling turn shows up as an O1 row of the run.

test("wiring: the aggregate path really opens and closes a ruling turn", async () => {
  const engine = await import("../task-engine.js");
  await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true, text: "ok" }), isBusy: () => false });
  const { attachDelegationAggregator } = await import("../server/delegation-aggregator.js");
  const chatHistory = await import("../chat-history.js");

  const fleet2 = fleetDb.createFleet({ id: "f_wire", name: "接线舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "w_up", fleetId: fleet2.id, title: "主编", targetKind: "persona", targetId: "p-w_up", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "w_t", fleetId: fleet2.id, title: "撰稿", targetKind: "persona", targetId: "p-w_t", kpiSlots: [], cadence: null });

  const ledger = createFleetTurnLedger({ db: fleetDb, engineRecords: () => engine.allRecords() });
  const prompts = [];
  const ctx = {
    currentPreset: "p-w_up",
    isStreaming: false,
    sessionCollectors: new Map(),
    taskTurnRegistry: new Map(),
    workerPool: { drain: async () => {} },
    dshBridge: {
      isReady: () => true,
      hasLiveMethod: () => false,
      // The collector path: hand back a completion notification so collectTurn
      // resolves; usage rides along, which is what the O1 row must carry.
      prompt: async (sessionId, blocks) => {
        prompts.push(sessionId);
        const collector = ctx.sessionCollectors.get(sessionId);
        if (collector) {
          // Shapes collectTurn actually reads: an assistant message carries the
          // text AND the usage; `session.status: idle` is what settles the turn.
          collector({
            method: "session.event",
            params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "裁决：两稿皆可" }] }, usage: { input: 500, output: 60 } } } },
          });
          collector({ method: "session.status", params: { status: "idle" } });
        }
        void blocks;
      },
    },
    fleetTurnLedger: ledger,
    finishTurn: () => {},
    broadcastSessions: () => {},
    broadcast: () => {},
    onRuntimeIdle: () => {},
  };
  // Keep the collector path (not the live one): currentSessionId must differ.
  chatHistory.setSessionManager({ getSessionId: () => "sess-somewhere-else" });

  const group = [hop({ initiator: "sess-wire", origin: { fleet: { fleetId: fleet2.id, memberId: "w_t", byMemberId: "w_up", chain: null } } })];
  const job = rulingTurnJob({ group, initiator: "sess-wire" });
  assert.ok(job);
  // Seed the run + the parent turn the way a real wave would.
  fleetDb.insertRun({ runId: "run_wire", fleetId: fleet2.id, rootSource: "schedule", rootMemberId: "w_up", startedAt: Date.now() - 60_000 });

  attachDelegationAggregator(ctx);
  // Drive one manual task through the engine so onFinished fires the aggregator.
  const t = engine.createManualTask({
    prompt: "写稿",
    persona: "p-w_t",
    sessionTitle: "扇出",
    initiator: "sess-wire",
    initiatorPreset: "p-w_up",
    initiatorGroup: "g_wire",
    origin: { fleet: { fleetId: fleet2.id, memberId: "w_t", byMemberId: "w_up", depth: 1, ignition: "k_wire", chain: { runId: "run_wire", parentTurnId: "turn_root", edgeKind: "fanout" } } },
  });
  await engine.idle();
  // The task above runs a stub turn; the aggregator arms when it finishes.
  await new Promise((r) => setTimeout(r, 300));
  await engine.idle();

  const rows = fleetDb.listRunTurns("run_wire");
  const ruling = rows.find((r) => r.source === "delegation" && r.memberId === "w_up");
  assert.ok(
    ruling,
    `the ruling turn is an O1 row of the run (rows: ${JSON.stringify(rows.map((r) => [r.memberId, r.source, r.parentTurnId]))})`,
  );
  assert.equal(ruling.parentTurnId, "turn_root", "chained under the wave's parent turn");
  assert.equal(ruling.edgeKind, "fanout");
  assert.equal(ruling.memberId, "w_up", "spoken by the post that ignited the wave");
  assert.ok(prompts.length >= 1, "the summary prompt actually went out");
  void t;
});
