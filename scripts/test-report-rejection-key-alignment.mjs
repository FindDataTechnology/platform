#!/usr/bin/env node
// ── Report rejection: the stash key must match the path that refused ────────
//
// fix-fleet-report-delivery 1.x, extended 2026-11-10.
//
// There are TWO ways a report gets refused, and they run at different points:
//
//   FLOOD refusal       — attribution SUCCEEDED, so a member id exists.
//   ATTRIBUTION refusal — happens BEFORE a member exists (`this agent is not a
//                         member of any fleet`); the only identity in hand is
//                         the live preset.
//
// The recorder reads the member id off the task record at turn end. So a
// preset-keyed refusal would never be taken — and that is exactly what happened
// live 2026-11-10: the bet post called report_status three times, got the
// 409 every time, and its turn detail came out `null`. The work existed only in
// a workspace file; the ledger said nothing.
//
// Pinned here: take() tries the member id FIRST, then the preset, clears
// whichever it found, and returns null when neither is stashed.
//
//   node --test scripts/test-report-rejection-key-alignment.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

// Mirrors server.js's record/take pair (Map + two-key lookup).
function makeStore() {
  const stash = new Map();
  return {
    record(key, fact) {
      if (!key || !fact) return;
      stash.set(key, fact);
    },
    take(memberId, presetId = null) {
      for (const key of [memberId, presetId]) {
        if (!key) continue;
        const fact = stash.get(key);
        if (fact) {
          stash.delete(key);
          return fact;
        }
      }
      return null;
    },
    size: () => stash.size,
  };
}

test("1. a member-keyed (flood) refusal is taken by member id", () => {
  const s = makeStore();
  s.record("m_1", { reason: "flood" });
  assert.equal(s.take("m_1", "ma-bet").reason, "flood");
  assert.equal(s.size(), 0, "and the entry is gone (one-shot)");
});

test("2. a preset-keyed (attribution) refusal is taken via the preset fallback", () => {
  const s = makeStore();
  // No member id existed when the refusal happened.
  s.record("ma-bet", { reason: "attribution_none", message: "this agent is not a member of any fleet" });
  const got = s.take("m_1794196030049_f1bsff", "ma-bet");
  assert.ok(got, "the 2026-11-10 bet-post case must now be visible");
  assert.equal(got.reason, "attribution_none");
  assert.equal(s.size(), 0);
});

test("3. member id wins when BOTH are stashed (flood is the more specific fact)", () => {
  const s = makeStore();
  s.record("m_1", { reason: "flood" });
  s.record("ma-bet", { reason: "attribution_none" });
  assert.equal(s.take("m_1", "ma-bet").reason, "flood");
  assert.equal(s.take("m_1", "ma-bet").reason, "attribution_none", "the second call takes the other");
});

test("4. nothing stashed ⇒ null, and no key is invented", () => {
  const s = makeStore();
  assert.equal(s.take("m_1", "ma-bet"), null);
  assert.equal(s.take(null, null), null);
  assert.equal(s.take(undefined, ""), null);
});

test("5. a null member id still resolves through the preset (the real case)", () => {
  const s = makeStore();
  s.record("hc-architect", { reason: "attribution_ambiguous" });
  assert.equal(s.take(null, "hc-architect").reason, "attribution_ambiguous");
});

test("6. one-shot: a taken refusal never replays on the next turn", () => {
  const s = makeStore();
  s.record("ma-bet", { reason: "attribution_none" });
  assert.ok(s.take("m_x", "ma-bet"));
  assert.equal(s.take("m_x", "ma-bet"), null, "the same preset must not re-report it");
});

test("7. a different preset cannot steal another preset's refusal", () => {
  const s = makeStore();
  s.record("ma-bet", { reason: "attribution_none" });
  assert.equal(s.take("m_x", "ma-analyze"), null);
  assert.equal(s.size(), 1, "still stashed for its own preset");
});
