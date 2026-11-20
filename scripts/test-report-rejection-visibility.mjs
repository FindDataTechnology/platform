#!/usr/bin/env node
// ── A refused report must be visible on the turn row ────────────────────────
//
// Live 2026-11-09 (fix-fleet-report-delivery 1.1): the proposal post produced a
// fully honest report — three slots, `proposals_rejected` labelled
// "未取得（decision_queue 403），非 0 拒" plus the previous round's un-repeated
// items — and the flood gate rejected it whole with a 429. The ONLY trace was
// a tool result the model saw; the turn row said nothing. The ledger therefore
// read "this post produced no report", which is what sent me looking for a
// model bug that did not exist.
//
// The bridge: stash at refusal, land on the turn row at its end — the same
// one-shot discipline the attribution fact already uses.
//
//   node --test scripts/test-report-rejection-visibility.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

// The bridge is two closures over a Map in server.js. Reproduce their contract
// here exactly (stash → take once → gone) so the semantics are pinned even
// though the wiring lives in a module that needs a database to import.
function makeBridge() {
  const store = new Map();
  return {
    record(memberId, fact) {
      if (!memberId || !fact) return;
      store.set(memberId, fact);
    },
    take(memberId) {
      const fact = store.get(memberId) ?? null;
      store.delete(memberId);
      return fact;
    },
  };
}

test("1. a refusal is readable once, then gone (one-shot, like attribution)", () => {
  const b = makeBridge();
  b.record("m_1", { reason: "flood", windowResetsAt: 1794275604000, slots: ["proposals_raised"] });
  const first = b.take("m_1");
  assert.equal(first.reason, "flood");
  assert.equal(first.windowResetsAt, 1794275604000);
  assert.deepEqual(first.slots, ["proposals_raised"]);
  assert.equal(b.take("m_1"), null, "a second take must not replay the same refusal");
});

test("2. no refusal ⇒ nothing lands (the detail stays byte-for-byte unchanged)", () => {
  const b = makeBridge();
  assert.equal(b.take("m_2"), null);
});

test("3. the fact is per-member — one post's refusal never surfaces on another", () => {
  const b = makeBridge();
  b.record("m_a", { reason: "flood" });
  assert.equal(b.take("m_b"), null);
  assert.equal(b.take("m_a").reason, "flood");
});

test("4. an empty member id or empty fact is ignored, never stored under ''", () => {
  const b = makeBridge();
  b.record("", { reason: "flood" });
  b.record("m_c", null);
  assert.equal(b.take(""), null);
  assert.equal(b.take("m_c"), null);
});

test("5. the landed detail shape keeps attribution and rejection side by side", () => {
  // Mirrors server.js: `detailFacts` merges both, and a turn may carry both —
  // the report WAS attributed to the right post and then refused.
  const detailFacts = {
    ...{ attribution: { source: "running-task", fleetId: "f", memberId: "m" } },
    ...{ reportRejected: { reason: "flood" } },
  };
  const detail = { ...{ kind: "whatever" }, ...detailFacts };
  assert.equal(detail.kind, "whatever", "existing detail keys survive");
  assert.equal(detail.attribution.memberId, "m");
  assert.equal(detail.reportRejected.reason, "flood");
});
