#!/usr/bin/env node
// ── Member identity is fail-closed on ambiguity (decision 2026-11-10) ───────
//
// A cron fire carries `sourceTag` { fleetId, memberId } straight off the task
// record, so the member is known without a config scan — that is what lets the
// member-patch branch (and the per-post MCP trimming inside it) run for fleet
// fires at all.
//
// The first version returned the FIRST match. But the same preset can
// legitimately be on the books twice (one persona holding posts in two fleets),
// and in that case the round would be handed ANOTHER post's memberId. That id
// flows into `memberTokenFor({ packId, memberId, … })` and lands in the private
// MCP patch's Authorization header — someone else's deployment token baked into
// this worker.
//
// Losing an identity is recoverable: the caller falls back to the shared patch,
// the documented pre-change behavior. Wearing another member's token is not.
// So: exactly one distinct (fleetId, memberId) pair wins; zero or many ⇒ null.
// This matches resolveAttribution's `ambiguous` direction (refuse, do not guess).
//
//   node --test scripts/test-member-identity-ambiguous.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { pickMemberIdentity, describeCandidates } = await import(
  path.join(here, "../lib/member-identity.js")
);

const rec = (preset, state, fleetId, memberId) => ({
  preset,
  state,
  sourceTag: { fleetId, memberId },
});

test("1. one running fire ⇒ that member wins", () => {
  const { identity, candidates } = pickMemberIdentity(
    [rec("ma-bet", "running", "f_1", "m_1")],
    "ma-bet",
  );
  assert.deepEqual(identity, { fleetId: "f_1", memberId: "m_1" });
  assert.equal(candidates.length, 1);
});

test("2. QUEUED counts too (patch is composed before the turn runs)", () => {
  const { identity } = pickMemberIdentity([rec("hc-architect", "queued", "f_2", "m_2")], "hc-architect");
  assert.deepEqual(identity, { fleetId: "f_2", memberId: "m_2" });
});

test("3. THE DECISION: the same preset on two fleets ⇒ null, not the first one", () => {
  // Pre-fix this returned f_A/m_A (first match), which would have baked A's
  // deployment token into B's worker.
  const { identity, candidates } = pickMemberIdentity(
    [rec("ma-bet", "running", "f_A", "m_A"), rec("ma-bet", "queued", "f_B", "m_B")],
    "ma-bet",
  );
  assert.equal(identity, null, "must refuse rather than guess");
  assert.equal(candidates.length, 2, "and must report both, so the refusal can be logged");
});

test("4. the same member with TWO records is NOT ambiguous (a retry is one post)", () => {
  // Distinctness is keyed on fleetId:memberId, not on record count.
  const { identity, candidates } = pickMemberIdentity(
    [rec("mo-eval", "running", "f_1", "m_1"), rec("mo-eval", "queued", "f_1", "m_1")],
    "mo-eval",
  );
  assert.deepEqual(identity, { fleetId: "f_1", memberId: "m_1" });
  assert.equal(candidates.length, 1);
});

test("5. finished fires never lend identity (done/failed/interrupted/skipped)", () => {
  for (const state of ["done", "failed", "interrupted", "skipped", null, undefined]) {
    const { identity } = pickMemberIdentity([rec("ma-analyze", state, "f_3", "m_3")], "ma-analyze");
    assert.equal(identity, null, `state=${state} must not resolve`);
  }
});

test("6. records without a usable sourceTag are ignored, not treated as a post", () => {
  const bad = [
    { preset: "ma-fetch", state: "running", sourceTag: null },
    { preset: "ma-fetch", state: "running", sourceTag: {} },
    { preset: "ma-fetch", state: "running", sourceTag: { fleetId: "f_9" } },
    { preset: "ma-fetch", state: "running", sourceTag: { memberId: "m_9" } },
  ];
  const { identity, candidates } = pickMemberIdentity(bad, "ma-fetch");
  assert.equal(identity, null);
  assert.equal(candidates.length, 0, "a half tag is not a member");
});

test("7. only the matching preset is considered", () => {
  const { identity } = pickMemberIdentity(
    [rec("mo-inventory", "running", "f_A", "m_A"), rec("mo-eval", "running", "f_B", "m_B")],
    "mo-eval",
  );
  assert.deepEqual(identity, { fleetId: "f_B", memberId: "m_B" });
});

test("8. empty preset / non-array records ⇒ null with no candidates", () => {
  assert.deepEqual(pickMemberIdentity([rec("x", "running", "f", "m")], null), { identity: null, candidates: [] });
  assert.deepEqual(pickMemberIdentity([rec("x", "running", "f", "m")], ""), { identity: null, candidates: [] });
  assert.deepEqual(pickMemberIdentity(null, "x"), { identity: null, candidates: [] });
});

test("9. three-way ambiguity is also refused (no 'first two are enough' shortcut)", () => {
  const { identity, candidates } = pickMemberIdentity(
    [
      rec("ma-bet", "running", "f_A", "m_A"),
      rec("ma-bet", "running", "f_B", "m_B"),
      rec("ma-bet", "queued", "f_C", "m_C"),
    ],
    "ma-bet",
  );
  assert.equal(identity, null);
  assert.equal(candidates.length, 3, "all three are reported for diagnosis");
});

test("10. describeCandidates renders a greppable list for the warn line", () => {
  assert.equal(
    describeCandidates([{ fleetId: "f_A", memberId: "m_A" }, { fleetId: "f_B", memberId: "m_B" }]),
    "f_A:m_A, f_B:m_B",
  );
  assert.equal(describeCandidates([]), "");
  assert.equal(describeCandidates(null), "");
});
