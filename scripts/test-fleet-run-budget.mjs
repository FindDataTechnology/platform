// Whole-run budget + stop switch (add-fleet-run-budget).
//
// Two things were missing: nothing bounded a CHAIN (per-edge timeouts bound one
// hop), and there was no way to stop a run that had gone wrong. This suite pins
// the three ceilings, the ignition gate that enforces them, and the cancel
// entry — including that a stop is recorded once and never overwritten.
//
// Run: node --test scripts/test-fleet-run-budget.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-budget-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const engine = await import("../task-engine.js");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true, text: "ok" }), isBusy: () => false });
const { constraintsOf, normalizeRunBudget, validateOrchestration, runBudgetDeclared } = await import(
  "../server/fleet-orchestration.js"
);
const { igniteFleetEdges, runAdmissionBlocked } = await import("../server/fleet-handoffs.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createFleetTurnLedger } = await import("../server/fleet-runs.js");

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

// ── declaration ─────────────────────────────────────────────────────────────

test("declaration: runBudget normalizes, and an undeclared budget means unlimited", () => {
  assert.deepEqual(normalizeRunBudget(undefined), { maxTurns: null, maxTokens: null, maxMinutes: null });
  assert.deepEqual(normalizeRunBudget({ maxTurns: 6 }), { maxTurns: 6, maxTokens: null, maxMinutes: null });
  assert.equal(runBudgetDeclared(normalizeRunBudget({ maxTurns: 6 })), true);
  assert.equal(runBudgetDeclared(normalizeRunBudget({})), false);
  assert.equal(runBudgetDeclared(normalizeRunBudget("nope")), false);
  // Unknown dimensions and non-positive values are floored to null.
  assert.deepEqual(normalizeRunBudget({ maxTurns: 0, maxTokens: -3 }), { maxTurns: null, maxTokens: null, maxMinutes: null });
});

test("declaration: constraintsOf carries the budget and never invents one", () => {
  assert.deepEqual(constraintsOf({}).runBudget, { maxTurns: null, maxTokens: null, maxMinutes: null });
  assert.equal(constraintsOf({ constraints: { runBudget: { maxMinutes: 30 } } }).runBudget.maxMinutes, 30);
});

test("declaration: validation refuses a malformed runBudget and an empty one", () => {
  const members = [{ id: "a" }, { id: "b" }];
  const bad = validateOrchestration({ members, orchestration: { constraints: { runBudget: 5 } } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.map((e) => e.error).join(" "), /runBudget must be an object/);

  const empty = validateOrchestration({ members, orchestration: { constraints: { runBudget: {} } } });
  assert.equal(empty.ok, false, "a declared-but-empty budget is a mistake, not 'no budget'");

  const unknown = validateOrchestration({ members, orchestration: { constraints: { runBudget: { maxUsd: 3 } } } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.map((e) => e.error).join(" "), /not a run-budget dimension/);

  const ok = validateOrchestration({ members, orchestration: { constraints: { runBudget: { maxTurns: 4 } } } });
  assert.equal(ok.ok, true, "a numeric ceiling passes the generic positive-number rule");
});

// ── the gate itself (pure) ──────────────────────────────────────────────────

test("gate: turns, tokens and minutes are three independent ceilings", () => {
  const fleet = fleetDb.createFleet({ id: "f_gate", name: "闸舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "g_a", fleetId: fleet.id, title: "A", targetKind: "persona", targetId: "p-g", kpiSlots: [], cadence: null });
  const runId = "run_gate";
  fleetDb.insertRun({ runId, fleetId: fleet.id, rootSource: "schedule", rootMemberId: "g_a", startedAt: Date.now() - 5 * 60_000 });
  const turn = (id, usage) =>
    fleetDb.appendTurnEvent({
      fleetId: fleet.id,
      memberId: "g_a",
      runId,
      turnId: id,
      source: "schedule",
      status: "ok",
      startedAt: Date.now(),
      endedAt: Date.now(),
      usage,
    });
  turn("t1", { input: 100, output: 50 });
  turn("t2", { input: 100, output: 50 });

  const db = fleetDb;
  assert.equal(runAdmissionBlocked(db, engine, runId, normalizeRunBudget({})), null, "no ceiling ⇒ nothing blocks");

  const byTurns = runAdmissionBlocked(db, engine, runId, normalizeRunBudget({ maxTurns: 2 }));
  assert.equal(byTurns.code, "run_budget");
  assert.match(byTurns.reason, /turn budget reached \(2\/2\)/);

  const byTokens = runAdmissionBlocked(db, engine, runId, normalizeRunBudget({ maxTokens: 300 }));
  assert.match(byTokens.reason, /token budget reached \(300\/300\)/);

  const byMinutes = runAdmissionBlocked(db, engine, runId, normalizeRunBudget({ maxMinutes: 1 }), { now: Date.now() });
  assert.match(byMinutes.reason, /time budget reached/);

  // Generous ceilings stay clear.
  assert.equal(runAdmissionBlocked(db, engine, runId, normalizeRunBudget({ maxTurns: 99, maxTokens: 99_999, maxMinutes: 999 })), null);
});

test("gate: an unknown run never blocks (legacy rows carry no header)", () => {
  assert.equal(runAdmissionBlocked(fleetDb, engine, "run_does_not_exist", normalizeRunBudget({ maxTurns: 1 })), null);
  assert.equal(runAdmissionBlocked(fleetDb, engine, null, normalizeRunBudget({ maxTurns: 1 })), null);
});

// ── ignition is the enforcement point ───────────────────────────────────────

test("ignition: a run over its turn ceiling ignites nothing and records the ceiling as its stop reason", async () => {
  const fleet = fleetDb.createFleet({ id: "f_ign", name: "点火闸舰", ownerEmail: "owner@test" });
  for (const id of ["i_src", "i_a"]) {
    fleetDb.createMember({ id, fleetId: fleet.id, title: id, targetKind: "persona", targetId: `p-${id}`, kpiSlots: [], cadence: null });
  }
  fleetDb.updateFleet(fleet.id, {
    orchestration: { edges: [{ kind: "handoff", from: "i_src", to: "i_a" }], constraints: { maxChainDepth: 3, runBudget: { maxTurns: 1 } } },
  });

  const ledger = createFleetTurnLedger({ db: fleetDb, engineRecords: () => engine.allRecords() });
  const job = { id: "j_ign", trigger: "schedule", targetType: "persona", preset: "t-i_src", sessionId: "cron-j_ign", sourceTag: { fleetId: fleet.id, memberId: "i_src" } };
  const handle = ledger.begin(job, { startedAt: Date.now(), sessionIds: ["cron-j_ign#r1"] });

  // The root turn itself counts as one turn of the run.
  fleetDb.appendTurnEvent({
    fleetId: fleet.id,
    memberId: "i_src",
    runId: handle.runId,
    turnId: handle.turnId,
    source: "schedule",
    status: "ok",
    startedAt: Date.now(),
    endedAt: Date.now(),
    usage: { input: 10, output: 5 },
  });

  const created = await igniteFleetEdges({ db: fleetDb, engine, job, ledgerTurn: handle, out: { ok: true, text: "产出" } });
  assert.equal(created, null, "maxTurns=1 and one turn already spent ⇒ no downstream hop");

  const run = fleetDb.getRun(handle.runId);
  assert.ok(run.stoppedAt != null, "the ceiling is stamped on the run");
  assert.match(run.stopReason, /^budget: run turn budget reached/);

  // And the refusal is visible as an honest event row, not silence.
  const rows = (fleetDb.db ?? fleetDb).prepare("SELECT error FROM member_turn_events WHERE fleet_id = 'f_ign'").all();
  assert.ok(rows.some((r) => /edge ignition refused: run turn budget reached/.test(r.error ?? "")), "the refusal is recorded");
});

test("ignition: a cancelled run stays closed — even with a generous budget", async () => {
  const fleet = fleetDb.createFleet({ id: "f_cx", name: "取消舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "c_src", fleetId: fleet.id, title: "源", targetKind: "persona", targetId: "p-cs", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "c_a", fleetId: fleet.id, title: "靶", targetKind: "persona", targetId: "p-ca", kpiSlots: [], cadence: null });
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [{ kind: "handoff", from: "c_src", to: "c_a" }], constraints: { maxChainDepth: 3 } } });

  const ledger = createFleetTurnLedger({ db: fleetDb, engineRecords: () => engine.allRecords() });
  const job = { id: "j_cx", trigger: "schedule", targetType: "persona", preset: "t-c_src", sessionId: "cron-j_cx", sourceTag: { fleetId: fleet.id, memberId: "c_src" } };
  const handle = ledger.begin(job, { startedAt: Date.now(), sessionIds: ["cron-j_cx#r1"] });

  const aborted = [];
  const stopped = ledger.stopRun(handle.runId, {
    reason: "cancelled by owner",
    abortTurn: (sid, why) => {
      aborted.push([sid, why]);
      return true;
    },
  });
  assert.equal(stopped.run.stopReason, "cancelled by owner");
  // Both ids the handle knows are offered to the registry: the mirror session
  // and the rotated child id the collector actually registers under. In
  // production only the latter resolves to an abort function; here every call
  // is recorded, so both show up.
  assert.deepEqual(
    aborted.map(([sid]) => sid).sort(),
    ["cron-j_cx", "cron-j_cx#r1"],
    "every session the run has in flight is offered to the abort registry",
  );
  assert.ok(aborted.every(([, why]) => why === "cancelled by owner"), "the reason rides the abort");

  const created = await igniteFleetEdges({ db: fleetDb, engine, job, ledgerTurn: handle, out: { ok: true, text: "产出" } });
  assert.equal(created, null, "no hop may be created from a stopped run");

  // Idempotent: a second stop keeps the first reason.
  const again = ledger.stopRun(handle.runId, { reason: "second call" });
  assert.equal(again.run.stopReason, "cancelled by owner", "first writer wins");
});

test("ignition: finalize never clears the stop stamp", async () => {
  const fleet = fleetDb.createFleet({ id: "f_fin", name: "收口舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "f_a", fleetId: fleet.id, title: "A", targetKind: "persona", targetId: "p-fa", kpiSlots: [], cadence: null });
  const runId = "run_fin";
  fleetDb.insertRun({ runId, fleetId: fleet.id, rootSource: "schedule", rootMemberId: "f_a", startedAt: Date.now() });
  fleetDb.stopRun(runId, { reason: "budget: run turn budget reached (1/1)" });
  fleetDb.appendTurnEvent({
    fleetId: fleet.id,
    memberId: "f_a",
    runId,
    turnId: "t_fin",
    source: "schedule",
    status: "ok",
    startedAt: Date.now(),
    endedAt: Date.now(),
  });
  const finalized = fleetDb.finalizeRun(runId);
  assert.equal(finalized.status, "ok", "status stays the derived outcome");
  assert.equal(finalized.stopReason, "budget: run turn budget reached (1/1)", "the stop reason survives the settle");
  assert.ok(finalized.stoppedAt != null);
});

test.after(async () => {
  await engine.idle?.();
  try { fleetDb.close(); } catch { /* shared handle */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── the owner's stop switch (route) ─────────────────────────────────────────

test("route: POST /runs/:runId/cancel stops the run, aborts its turns, and is idempotent", async () => {
  const express = (await import("express")).default;
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const fleet = fleetDb.createFleet({ id: "f_route", name: "路由舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "r_a", fleetId: fleet.id, title: "岗", targetKind: "persona", targetId: "p-ra", kpiSlots: [], cadence: null });

  const ledger = createFleetTurnLedger({ db: fleetDb, engineRecords: () => engine.allRecords() });
  const job = { id: "j_route", trigger: "schedule", targetType: "persona", preset: "t-r_a", sessionId: "cron-j_route", sourceTag: { fleetId: fleet.id, memberId: "r_a" } };
  const handle = ledger.begin(job, { startedAt: Date.now(), sessionIds: ["cron-j_route#r1"] });

  const aborted = [];
  const registry = new Map([["cron-j_route#r1", (why) => aborted.push(why)]]);

  const app = express();
  app.use(express.json());
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "t-r_a",
    fleetTurnLedger: ledger,
    taskTurnRegistry: registry,
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cancel = (runId, body) =>
    fetch(`${base}/api/fleets/${fleet.id}/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    const first = await cancel(handle.runId);
    assert.equal(first.status, 200);
    assert.equal(first.body.cancelled, true);
    assert.equal(first.body.alreadyStopped, false);
    assert.equal(first.body.run.stopReason, "cancelled by owner");
    assert.ok(first.body.run.stoppedAt != null);
    assert.deepEqual(aborted, ["cancelled by owner"], "the in-flight collector was aborted");

    // A repeat answers with the stored reason and rewinds nothing.
    const second = await cancel(handle.runId, { reason: "ignored" });
    assert.equal(second.body.alreadyStopped, true);
    assert.equal(second.body.run.stopReason, "cancelled by owner");
    assert.deepEqual(aborted, ["cancelled by owner"], "no second abort");

    // Unknown / foreign runs are 404, never a cross-fleet write.
    assert.equal((await cancel("run_nope")).status, 404);
    const other = fleetDb.createFleet({ id: "f_other", name: "别舰", ownerEmail: "someone@else" });
    fleetDb.insertRun({ runId: "run_foreign", fleetId: other.id, rootSource: "schedule", rootMemberId: "x", startedAt: Date.now() });
    assert.equal((await cancel("run_foreign")).status, 404);
  } finally {
    server.close();
  }
});
