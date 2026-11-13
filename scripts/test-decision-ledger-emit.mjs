// Unit tests for decision-ledger emission (generalize-decision-contract 7.1 / 7.2).
//
// The two properties that matter:
//   7.1 default OFF — a fleet that has not opted in behaves as before;
//   7.2 a ledger outage never rolls back the approval — the approval is the
//       human's act, the ledger is bookkeeping. Failure is recorded, not raised.
//
// Run: node --test scripts/test-decision-ledger-emit.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMIT_ENV,
  buildDecisionFromResolution,
  emitDecision,
  emitEnabled,
  flushOutbox,
} from "../lib/decision-ledger-emit.js";

const SETTLE = {
  metric_ref: "cell/store_gross_margin",
  comparator: "gte",
  threshold: 0.42,
  subject_kind: "contract",
  horizon: { unit: "month", count: 6 },
};

function item(over = {}) {
  return {
    id: "d-100",
    question: "把 0413 店的补货周期从 7 天改为 5 天？",
    category: "routine-ops",
    severity: "P3",
    detail: { settlement: SETTLE, preconditions: [] },
    ...over,
  };
}

const fleet = { id: "fleet-9" };
const approved = { kind: "approve", choice: "yes-5-days", note: "库存周转能扛住", by: "owner@x.io" };

test("emission is OFF by default", () => {
  assert.equal(emitEnabled({}), false);
  assert.equal(emitEnabled({ [EMIT_ENV]: "0" }), false);
  assert.equal(emitEnabled({ [EMIT_ENV]: "1" }), true);
});

test("maps an approved item into Decision v2", () => {
  const res = buildDecisionFromResolution({
    item: item(), fleet, resolution: approved, now: Date.UTC(2026, 10, 10),
  });

  assert.equal(res.ok, true);
  const p = res.payload;
  assert.equal(p.schema_version, "2");
  assert.equal(p.as_of, "2026-11-10");
  assert.equal(p.subject, "d-100");
  assert.equal(p.action, "yes-5-days");
  assert.equal(p.settlement_rule_id, "metric_threshold");
  assert.equal(p.expected_outcome.metric_ref, "cell/store_gross_margin");
  assert.equal(p.expected_outcome.settlement_source, "caller_supplied_series");
  assert.equal(p.producer.pack, "paas/fleet-decision-lane");
  assert.match(p.basis, /库存周转/);
});

test("reject also produces a settleable decision", () => {
  const res = buildDecisionFromResolution({
    item: item(), fleet,
    resolution: { kind: "reject", choice: null, note: "周期太短会断货", by: "owner@x.io" },
    now: Date.UTC(2026, 10, 10),
  });

  assert.equal(res.ok, true);
  assert.equal(res.payload.action, "reject");
});

test("an item with no settlement spec is refused, not invented", () => {
  const res = buildDecisionFromResolution({
    item: item({ detail: {} }), fleet, resolution: approved,
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_settlement_spec");
});

test("bad settlement fields are refused with the offending value", () => {
  const cases = [
    [{ metric_ref: "  " }, "settlement_metric_ref_missing"],
    [{ comparator: "约等于" }, "settlement_comparator_invalid:约等于"],
    [{ threshold: "0.42" }, "settlement_threshold_not_numeric"],
    [{ threshold: Object.assign(new Number(0.42), {}) }, "settlement_threshold_not_numeric"],
  ];
  for (const [patch, reason] of cases) {
    const res = buildDecisionFromResolution({
      item: item({ detail: { settlement: { ...SETTLE, ...patch } } }),
      fleet, resolution: approved,
    });
    assert.equal(res.ok, false, JSON.stringify(patch));
    assert.equal(res.reason, reason, JSON.stringify(patch));
  }
});

test("a non-emittable resolution kind is refused", () => {
  const res = buildDecisionFromResolution({
    item: item(), fleet, resolution: { kind: "expired", choice: null },
  });

  assert.equal(res.ok, false);
  assert.match(res.reason, /not_emittable/);
});

test("successful send reports delivered", async () => {
  const res = buildDecisionFromResolution({
    item: item(), fleet, resolution: approved, now: Date.UTC(2026, 10, 10),
  });
  const outbox = [];
  const out = await emitDecision({
    payload: res.payload, outbox, send: async () => ({ decision_id: "q-1" }),
  });

  assert.equal(out.delivered, true);
  assert.equal(out.queued, false);
  assert.equal(outbox.length, 0);
});

test("a ledger outage queues for retry and never throws (7.2)", async () => {
  const res = buildDecisionFromResolution({
    item: item(), fleet, resolution: approved, now: Date.UTC(2026, 10, 10),
  });
  const outbox = [];
  const out = await emitDecision({
    payload: res.payload, outbox,
    send: async () => { throw new Error("ledger unreachable"); },
  });

  assert.equal(out.delivered, false);
  assert.equal(out.queued, true);
  assert.match(out.error, /ledger unreachable/);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].payload.subject, "d-100");
  assert.equal(outbox[0].attempts, 1);
});

test("an outbox that itself throws still does not surface as failure", async () => {
  const res = buildDecisionFromResolution({
    item: item(), fleet, resolution: approved, now: Date.UTC(2026, 10, 10),
  });
  const out = await emitDecision({
    payload: res.payload,
    outbox: { push() { throw new Error("outbox down"); } },
    send: async () => { throw new Error("ledger unreachable"); },
  });

  assert.equal(out.delivered, false);
  assert.equal(out.queued, true);
});

test("flush retries keep only the rows that still fail", async () => {
  const ok = { payload: { subject: "a" }, attempts: 1 };
  const bad = { payload: { subject: "b" }, attempts: 1 };
  const out = await flushOutbox({
    outbox: [ok, bad],
    send: async (p) => { if (p.subject === "b") throw new Error("still down"); },
  });

  assert.equal(out.sent, 1);
  assert.equal(out.remaining.length, 1);
  assert.equal(out.remaining[0].payload.subject, "b");
  assert.equal(out.remaining[0].attempts, 2);
});

test("flush of an empty or absent outbox is a no-op", async () => {
  assert.deepEqual(await flushOutbox({ outbox: [], send: async () => {} }), { sent: 0, remaining: [] });
  assert.deepEqual(await flushOutbox({ outbox: null, send: async () => {} }), { sent: 0, remaining: [] });
});
