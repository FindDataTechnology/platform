// Premise-invalidated → escalation payload (add-decision-consistency-and-premise-watch 3.4).
//
// The properties that matter:
//   - the produced payload passes the fleet lane's OWN validator (no invented shape);
//   - severity is derived, not declared (a producer must not be able to whisper);
//   - a blind breach (no observation) outranks a threshold breach;
//   - nothing is dropped silently — `complete` self-proves.
//
// Run: node --test scripts/test-premise-escalation.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateEscalatePayload, SEVERITIES } from "../server/fleet-decisions.js";
import {
  OPTION_HOLD,
  OPTION_REEVALUATE,
  buildEscalationFromPremiseEvent,
  buildEscalations,
} from "../lib/premise-escalation.js";

function event(over = {}) {
  return {
    event: "premise_invalidated",
    decision_id: "dec-1",
    precondition_index: 0,
    metric_ref: "financials.gross_margin",
    observed_value: 0.31,
    comparator: "gte",
    threshold: 0.42,
    evaluated_at: "2026-11-10T08:00:00",
    series_fingerprint: "9f3a2c",
    ...over,
  };
}

test("payload passes the fleet lane's own validator", () => {
  const res = buildEscalationFromPremiseEvent(event());

  assert.equal(res.ok, true);
  assert.equal(validateEscalatePayload(res.payload).ok, true, JSON.stringify(validateEscalatePayload(res.payload)));
});

test("question is answerable in thirty seconds: decision, precondition, value, rule", () => {
  const { payload } = buildEscalationFromPremiseEvent(event());

  assert.match(payload.question, /dec-1/);
  assert.match(payload.question, /前提 #0/);
  assert.match(payload.question, /financials\.gross_margin/);
  assert.match(payload.question, /0\.31/);
  assert.match(payload.question, /gte 0\.42/);
  assert.ok(payload.question.length <= 500);
});

test("options are exactly the two meaningful answers", () => {
  const { payload } = buildEscalationFromPremiseEvent(event());

  assert.deepEqual(payload.options.map((o) => o.value), [OPTION_REEVALUATE, OPTION_HOLD]);
  assert.ok(payload.options.every((o) => o.label.length > 0));
});

test("severity is derived: a threshold breach is normal", () => {
  const { payload } = buildEscalationFromPremiseEvent(event());

  assert.equal(payload.severity, "normal");
  assert.ok(SEVERITIES.includes(payload.severity));
});

test("severity is derived: a blind breach outranks a threshold breach", () => {
  const { payload } = buildEscalationFromPremiseEvent(event({ observed_value: null }));

  assert.equal(payload.severity, "high");
  assert.match(payload.question, /未取得观测值/);
});

test("severity cannot be dictated by the event", () => {
  const { payload } = buildEscalationFromPremiseEvent(
    event({ observed_value: 0.01, severity: "low" }),
  );

  assert.equal(payload.severity, "normal", "事件自报的 severity 必须被忽略");
});

test("deadline is a display-only date string derived from now", () => {
  const { payload } = buildEscalationFromPremiseEvent(
    event(), { now: Date.UTC(2026, 10, 10), deadlineDays: 3 },
  );

  assert.equal(payload.suggestedDeadline, "2026-11-13");
  assert.equal(typeof payload.suggestedDeadline, "string");
});

test("a missing fingerprint is refused — the item would be unanswerable", () => {
  const res = buildEscalationFromPremiseEvent(event({ series_fingerprint: "" }));

  assert.equal(res.ok, false);
  assert.equal(res.reason, "series_fingerprint_missing");
});

test("missing decision id / metric ref are refused with distinct reasons", () => {
  assert.equal(buildEscalationFromPremiseEvent(event({ decision_id: "  " })).reason,
    "decision_id_missing");
  assert.equal(buildEscalationFromPremiseEvent(event({ metric_ref: "" })).reason,
    "metric_ref_missing");
  assert.equal(buildEscalationFromPremiseEvent(null).reason, "event_missing");
});

test("batch keeps every input accounted for", () => {
  const out = buildEscalations([
    event({ decision_id: "a" }),
    event({ decision_id: "b", series_fingerprint: "" }),
    event({ decision_id: "c", observed_value: null }),
  ]);

  assert.deepEqual(out.counts, { total: 3, built: 2, refused: 1 });
  assert.equal(out.complete, true);
  assert.equal(out.refused[0].decision_id, "b");
  assert.equal(out.refused[0].reason, "series_fingerprint_missing");
});

test("batch of an empty or absent list is trivially complete", () => {
  assert.deepEqual(buildEscalations([]).counts, { total: 0, built: 0, refused: 0 });
  assert.equal(buildEscalations(undefined).complete, true);
});

test("the original event is not mutated", () => {
  const ev = event();
  const snapshot = JSON.stringify(ev);
  buildEscalationFromPremiseEvent(ev);

  assert.equal(JSON.stringify(ev), snapshot);
});
