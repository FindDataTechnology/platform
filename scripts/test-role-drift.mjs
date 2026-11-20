// Role drift between the two stores (openspec: intent-onboarding).
//
// The questionnaire answer (per-cell intent profile) and the user's business
// role (the gateway's assignment document) are separate stores. Nothing
// compared them, so a failed gateway write left "answered: legal" with the
// role still `standard` — permanently, invisibly. This pins the comparison.

import assert from "node:assert/strict";
import { test } from "node:test";
import { roleDrift } from "../server/onboarding.js";

const answered = (role, extra = {}) => ({ roles: [role], answeredAt: "2026-10-16T00:00:00Z", skipped: false, ...extra });

test("aligned answer and role report no drift", () => {
  assert.equal(roleDrift({ intent: answered("legal"), assignment: { primary: "legal", source: "gateway" } }), null);
});

test("an answer whose role never landed IS drift — the live case", () => {
  const d = roleDrift({
    intent: answered("legal"),
    assignment: { primary: "standard", source: "fallback" },
  });
  assert.deepEqual(d, { answeredPrimary: "legal", assignedPrimary: "standard", assignmentSource: "fallback" });
});

test("an unanswered profile is not drift (it is 'not asked yet')", () => {
  assert.equal(roleDrift({ intent: { roles: [], answeredAt: null, skipped: false }, assignment: { primary: "standard" } }), null);
  assert.equal(roleDrift({ intent: null, assignment: { primary: "standard" } }), null);
});

test("a skipped profile is not drift (an explicit decline)", () => {
  // Skipped WITH roles present: the only shape that isolates the skipped
  // guard — with an empty role list the empty-primary check would also pass,
  // and a mutation deleting the skipped guard would go unnoticed.
  assert.equal(roleDrift({ intent: { roles: ["legal"], answeredAt: "2026-10-16T00:00:00Z", skipped: true }, assignment: { primary: "standard" } }), null);
  assert.equal(roleDrift({ intent: { roles: [], answeredAt: null, skipped: true }, assignment: { primary: "standard" } }), null);
});

test("an answer with an empty role list is not drift", () => {
  assert.equal(roleDrift({ intent: { roles: [], answeredAt: "2026-10-16T00:00:00Z", skipped: false }, assignment: { primary: "standard" } }), null);
});

test("drift names the assignment's source so an operator can tell why", () => {
  const d = roleDrift({ intent: answered("stock"), assignment: { primary: "standard", source: "env-default" } });
  assert.equal(d.assignmentSource, "env-default");
});

test("a missing assignment degrades to a null primary, still reported", () => {
  const d = roleDrift({ intent: answered("legal"), assignment: null });
  assert.equal(d.assignedPrimary, null);
  assert.equal(d.assignmentSource, null);
});
