// ── fleet-ops-manager: repair brain + verify (openspec: fleet-ops-manager) ──
//
//   node --test scripts/test-fleet-ops-manager.mjs
//
// Two things this must prove, because they are the whole difference between an
// AI manager and a suggestion bot: (1) a repair can ONLY touch what the
// diagnosis justifies (whitelist, machine-checked), and (2) no evidence means no
// repair — never a guess, never an empty diff masquerading as "fixed".

import assert from "node:assert/strict";
import { test } from "node:test";
import { repairDraft, verifyOutcome, REPAIR_WHITELIST, applyTeamDiff, whitelistViolations } from "../lib/fleet-ops-manager.js";

function liveRow(over = {}) {
  return {
    id: "m1",
    title: "分析师",
    parentId: null,
    targetKind: "persona",
    targetId: "a1",
    kpiSlots: [],
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "出简报" },
    model: "expensive-flash",
    fallbackModel: null,
    effort: "high",
    contextBudget: 200000,
    ...over,
  };
}

const ROSTER = [
  { id: "expensive-flash", budgetRemainingPct: 5 },
  { id: "glm-cheap", budgetRemainingPct: 80 },
  { id: "spark", budgetRemainingPct: 60 },
];

// ── per-kind whitelist ──────────────────────────────────────────────────────

test("budget: repair only adds a healthy fallbackModel (no other key)", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "budget" }],
    liveRows: [liveRow()],
    modelRoster: ROSTER,
  });
  assert.equal(out.ok, true);
  assert.equal(out.diff.updates.length, 1);
  const u = out.diff.updates[0];
  assert.equal(u.after.fallbackModel, "glm-cheap"); // healthiest
  // only fallbackModel changed
  for (const k of ["model", "effort", "cadence", "kpiSlots"]) {
    assert.deepEqual(u.after[k], u.before[k], `budget repair must not touch ${k}`);
  }
  assert.deepEqual([...REPAIR_WHITELIST.budget], ["model", "fallbackModel", "effort"]);
});

test("model_upstream: repair adds a fallback (whitelist model/fallbackModel)", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "model_upstream" }],
    liveRows: [liveRow()],
    modelRoster: ROSTER,
  });
  assert.equal(out.ok, true);
  assert.equal(out.diff.updates[0].after.fallbackModel, "glm-cheap");
});

test("timeout: repair raises cadence.turnTimeoutMs only", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "timeout", evidence: { turnTimeoutMs: 600000 } }],
    liveRows: [liveRow()],
    modelRoster: ROSTER,
  });
  assert.equal(out.ok, true);
  const after = out.diff.updates[0].after;
  assert.equal(after.cadence.turnTimeoutMs, 600000);
  assert.equal(after.cadence.cron, "0 9 * * *"); // cron untouched
});

test("apply(diff) equals the desired structure (round-trip)", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "budget" }],
    liveRows: [liveRow()],
    modelRoster: ROSTER,
  });
  const applied = applyTeamDiff([{ ...liveRow(), target: { kind: "existing-persona", id: "a1" }, kpiSlots: [], memory: null, fallbackModel: null, effort: "high", contextBudget: 200000, carrier: null, inputPolicy: null, concurrency: null, workbench: null, model: "expensive-flash", parentRef: null, ref: "m1", title: "分析师", cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "出简报" } }], out.diff);
  assert.equal(applied[0].fallbackModel, "glm-cheap");
});

// ── evidence insufficient (NOT a repair) vs no-repair-needed ────────────────

test("budget with no healthy candidate → insufficient evidence, not a guess", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "budget" }],
    liveRows: [liveRow()],
    modelRoster: [{ id: "expensive-flash", budgetRemainingPct: 5 }],
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /insufficient evidence/);
  assert.equal(out.missingEvidence[0].reason.includes("no healthy candidate"), true);
});

test("timeout without turn-timeout evidence → insufficient evidence", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "timeout" }],
    liveRows: [liveRow()],
    modelRoster: ROSTER,
  });
  assert.equal(out.ok, false);
  assert.match(out.missingEvidence[0].reason, /turn-timeout evidence/);
});

test("unknown error_kind → no repair, not a guess", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "cosmic-ray" }],
    liveRows: [liveRow()],
    modelRoster: ROSTER,
  });
  assert.equal(out.ok, false);
  assert.match(out.missingEvidence[0].reason, /no repair mapping/);
});

test("NO-REPAIR (already has fallback) is distinct from insufficient evidence", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "budget" }],
    liveRows: [liveRow({ fallbackModel: "glm-cheap" })],
    modelRoster: ROSTER,
  });
  assert.equal(out.ok, true);
  assert.equal(out.noRepairNeeded, true);
});

// ── negative self-proof: whitelist violation is refused ─────────────────────

test("NEGATIVE: a change outside the whitelist is refused as non-diagnosis-derived", () => {
  // Drive the actual guard (not just a set-membership assertion): hand it a
  // desired that edits a key the budget diagnosis does not justify, and prove it
  // is caught and named. This is the negative self-proof the spec requires.
  const before = [{ ref: "m1", cadence: { cron: "0 9 * * *" }, kpiSlots: [], model: "x", fallbackModel: null }];
  const after = [{ ref: "m1", cadence: { cron: "0 9 * * *" }, kpiSlots: [], model: "x", fallbackModel: "y", effort: "low" }];
  // effort IS whitelisted for budget → no violation.
  assert.deepEqual(whitelistViolations([{ ref: "m1", errorKind: "budget" }], before, after), []);
  // now a non-whitelisted key (kpiSlots) changes → violation named.
  const after2 = [{ ref: "m1", cadence: { cron: "0 9 * * *" }, kpiSlots: [{ key: "k", label: "L" }], model: "x", fallbackModel: "y" }];
  const v = whitelistViolations([{ ref: "m1", errorKind: "budget" }], before, after2);
  assert.equal(v.length, 1);
  assert.equal(v[0].key, "kpiSlots");
  // cadence edited under a non-timeout kind → violation, even though cadence is
  // in timeout's whitelist.
  const after3 = [{ ref: "m1", cadence: { cron: "0 9 * * *", turnTimeoutMs: 600000 }, kpiSlots: [], model: "x", fallbackModel: "y" }];
  const v2 = whitelistViolations([{ ref: "m1", errorKind: "budget" }], before, after3);
  assert.ok(v2.some((x) => x.key === "cadence"));
  // sanity: whitelist set membership
  assert.equal(REPAIR_WHITELIST.budget.includes("cadence"), false);
  assert.equal(REPAIR_WHITELIST.timeout.includes("fallbackModel"), false);
});

// ── verifyOutcome: three states, never merged ───────────────────────────────

test("verify: improved when count drops", () => {
  const v = verifyOutcome({ kind: "budget", beforeCount: 10, afterCount: 2 });
  assert.equal(v.state, "improved");
  assert.deepEqual([v.before, v.after], [10, 2]);
});

test("verify: unchanged when count does not drop (never claims fixed)", () => {
  const v = verifyOutcome({ kind: "budget", beforeCount: 10, afterCount: 10 });
  assert.equal(v.state, "unchanged");
});

test("verify: insufficient-evidence when sample too small or counts missing", () => {
  assert.equal(verifyOutcome({ kind: "budget", beforeCount: 1, afterCount: 0 }).state, "insufficient-evidence");
  assert.equal(verifyOutcome({ kind: "budget", beforeCount: null, afterCount: 3 }).state, "insufficient-evidence");
});

test("verify: the three-state set is exhaustive and distinct", () => {
  const states = new Set([
    verifyOutcome({ kind: "x", beforeCount: 10, afterCount: 1 }).state,
    verifyOutcome({ kind: "x", beforeCount: 10, afterCount: 10 }).state,
    verifyOutcome({ kind: "x", beforeCount: 1, afterCount: 0 }).state,
  ]);
  assert.deepEqual([...states].sort(), ["improved", "insufficient-evidence", "unchanged"]);
});
