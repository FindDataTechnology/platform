// Turn-contract admission (agent-turn-contract; explore P2-7 third bullet).
//
// `assertTurnRequest` guarded the contract's reserved values and depth bounds
// with tests and NO production caller: the bound was enforced only where a
// chain position is CREATED (dispatch pins 1; handoff/fanout check at ignition).
// A fleet that SHRANK its declared maxChainDepth left already-queued hops
// admissible at creation and out-of-bound at execution — nothing refused them.
//
// The gate now runs at the turn (cron-runner, before the ledger opens) and
// reads the fleet's CURRENT declaration. `null` means admissible (or not a
// fleet turn at all) — a caller must never read it as a refusal.
//
// Run: node --test scripts/test-turn-contract-admission.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-admission-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");

// Engine imported for its module side effects (the route module reads it).
await import("../task-engine.js");
const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createFleetTurnLedger } = await import("../server/fleet-runs.js");
const { recordTurnEvent } = await import("../server/fleet-events.js");
const { attachCronRunner } = await import("../server/cron-runner.js");

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });

test.after(() => {
  try { fleetDb.close(); } catch { /* shared handle */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

let seq = 0;
function fleetWith(maxChainDepth) {
  const id = `f_adm_${++seq}`;
  fleetDb.createFleet({ id, name: `准入舰${seq}`, ownerEmail: "owner@test" });
  fleetDb.createMember({ id: `${id}_up`, fleetId: id, title: "上游", targetKind: "persona", targetId: `p-${id}_up`, parentId: null, kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: `${id}_dn`, fleetId: id, title: "下游", targetKind: "persona", targetId: `p-${id}_dn`, parentId: `${id}_up`, kpiSlots: [], cadence: null });
  // The declaration lives on the fleet row (the same place the write face
  // validates and the ignition lanes read).
  if (maxChainDepth != null) {
    fleetDb.db.prepare("UPDATE fleets SET orchestration = ? WHERE id = ?").run(JSON.stringify({ constraints: { maxChainDepth } }), id);
  }
  return { fleetId: id, up: `${id}_up`, down: `${id}_dn` };
}

const hopJob = (f, depth, id = `j_${Math.random().toString(36).slice(2, 8)}`) => ({
  id,
  trigger: "manual",
  targetType: "persona",
  preset: `p-${f.down}`,
  prompt: "接棒干活",
  sessionId: `task-${id}`,
  initiator: "sess-up",
  initiatorPreset: `p-${f.up}`,
  origin: { fleet: { fleetId: f.fleetId, memberId: f.down, depth, byMemberId: f.up, chain: { runId: "run_x", parentTurnId: "turn_x", edgeKind: "handoff" } } },
});

test("admission: 非舰队任务不判（null 不是拒绝）", () => {
  const ledger = createFleetTurnLedger({ db: fleetDb });
  assert.equal(ledger.admission({ id: "j1", trigger: "schedule", preset: "p", prompt: "x" }), null);
  assert.equal(ledger.admission(null), null);
});

test("admission: 声明链内放行，缩过的声明立即拒绝", () => {
  const wide = fleetWith(5);
  const ledger = createFleetTurnLedger({ db: fleetDb });
  assert.equal(ledger.admission(hopJob(wide, 3)), null, "depth 3 inside a declared 5 passes");

  const narrow = fleetWith(2);
  const err = ledger.admission(hopJob(narrow, 3));
  assert.ok(err?.error, "depth 3 past a declared 2 is refused");
  assert.match(err.error, /depth must be within/);
});

test("admission: dispatch 道恒 1（默认声明下 depth 2 也拒绝）", () => {
  const plain = fleetWith(null); // no orchestration → default maxChainDepth 8
  const ledger = createFleetTurnLedger({ db: fleetDb });
  assert.equal(ledger.admission(hopJob(plain, 1)), null);
  assert.equal(ledger.admission(hopJob(plain, 8)), null, "the default declaration admits up to 8");
  const over = ledger.admission(hopJob(plain, 9));
  assert.ok(over?.error, "past the default bound is refused");
});

test("接线：超界的那一轮以失败收口并落一条诚实事件，正常轮照跑", async () => {
  const f = fleetWith(1);
  const turnEvents = [];
  const ctx = {
    session: { model: { id: "m0" } },
    taskTurnRegistry: new Map(),
    sessionCollectors: new Map(),
    broadcast: () => {},
    dshBridge: { isReady: () => true },
  };
  ctx.fleetTurnLedger = createFleetTurnLedger({ db: fleetDb });
  ctx.recordFleetTurnEvent = (job, out, meta) => {
    turnEvents.push({ job, out });
    return meta?.ledgerTurn ? ctx.fleetTurnLedger.end(job, meta.ledgerTurn, out, meta) : recordTurnEvent(fleetDb, job, out, meta);
  };
  attachCronRunner(ctx, {
    runPersona: async () => ({ ok: true, text: "完成" }),
    runA2a: async () => ({ ok: true }),
    listAgents: () => [],
  });

  const refused = await ctx.runCronJobTurn(hopJob(f, 4), { timeoutMs: 5000 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /turn contract refused: .*depth must be within/);
  const recorded = turnEvents.find((e) => /turn contract refused/.test(String(e.out?.error)));
  assert.ok(recorded, "the refusal is recorded, not silently dropped");

  const ok = await ctx.runCronJobTurn(hopJob(f, 1), { timeoutMs: 5000 });
  assert.equal(ok.ok, true, "an admissible hop still runs");
});
