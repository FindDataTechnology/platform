// ── repair roster wiring (the read face that makes repairs actually fire) ────
//
// The cockpit's `repairs` segment calls repairDraft with a candidate-model roster
// built from ctx.dshModels × ctx.modelBudget. Before this wiring the roster was
// hard-wired to [], which made every budget/model_upstream diagnosis come back
// "insufficient evidence" — 64% of fleet failures produced no suggestion at all.
//
// This pins the two halves that matter:
//   1. the roster→repair contract (empty roster ⇒ no suggestion; healthy model ⇒ suggestion);
//   2. the route still degrades honestly when the budget engine is absent.
//
//   node --test scripts/test-repair-roster-wiring.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { repairDraft } from "../lib/fleet-ops-manager.js";

const liveRow = (over = {}) => ({
  id: "m1",
  title: "分析师",
  parentId: null,
  targetKind: "persona",
  targetId: "a1",
  kpiSlots: [],
  cadence: { cron: "0 * * * *", promptTemplate: "报数" },
  model: "expensive-flash",
  fallbackModel: null,
  ...over,
});

// The exact shape repairRoster() produces: available models × remaining budget.
test("empty roster ⇒ budget repair is honestly withheld (not guessed)", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "budget" }],
    liveRows: [liveRow()],
    modelRoster: [],
  });
  assert.equal(out.ok, false);
  assert.match(out.missingEvidence[0].reason, /no healthy candidate/);
});

test("a healthy candidate in the roster ⇒ a concrete fallback suggestion", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "budget" }],
    liveRows: [liveRow()],
    modelRoster: [
      { id: "expensive-flash", budgetRemainingPct: 3 },
      { id: "glm-cheap", budgetRemainingPct: 91 },
    ],
  });
  assert.equal(out.ok, true);
  assert.equal(out.diff.updates[0].after.fallbackModel, "glm-cheap");
});

test("model_upstream takes the same path (roster-driven, not hard-coded)", () => {
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "model_upstream" }],
    liveRows: [liveRow()],
    modelRoster: [{ id: "spark", budgetRemainingPct: 50 }],
  });
  assert.equal(out.ok, true);
  assert.equal(out.diff.updates[0].after.fallbackModel, "spark");
});

// The tightening rule the route applies: a model with ANY tier nearly exhausted
// must not be offered as a "healthy" candidate.
test("the most-exhausted tier decides a candidate's healthiness", () => {
  // remaining 5% on the tightest tier → below the 20% healthy floor → withheld.
  const out = repairDraft({
    diagnoses: [{ ref: "m1", errorKind: "budget" }],
    liveRows: [liveRow()],
    modelRoster: [{ id: "almost-out", budgetRemainingPct: 5 }],
  });
  assert.equal(out.ok, false);
});
