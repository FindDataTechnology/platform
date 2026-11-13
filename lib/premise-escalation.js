// Premise-invalidated → escalation item
// (add-decision-consistency-and-premise-watch 3.4 / 4.3).
//
// When a decision's precondition stops holding, the system must tell a human —
// not silently re-decide. This module turns a `premise_invalidated` event (built
// by fd-quant's `build_premise_invalidated_event`) into a fleet decision-lane
// escalation payload, so it lands in the owner's queue with everything they
// need to answer in thirty seconds.
//
// Two rules from the change's spec are encoded here, not left to prose:
//
//   1. **severity is derived, never declared by the producer.** A producer that
//      can label its own alarm "low" will eventually do so to avoid attention.
//      Derivation is by what actually broke: a missing observation point is
//      `high` (we are blind), a breached threshold is `normal`.
//
//   2. **the options are fixed and mutually exclusive.** "Re-examine" / "keep it
//      despite the breach" are the only two things a human can meaningfully say;
//      offering more invents decisions the owner does not have.

export const OPTION_REEVALUATE = "reevaluate";
export const OPTION_HOLD = "hold-despite-breach";

/**
 * Build an escalation payload from a premise_invalidated event.
 *
 * Returns {ok:true, payload} or {ok:false, reason}. `payload` matches
 * `validateEscalatePayload` in server/fleet-decisions.js
 * (question ≤500, options 2..6 of {value,label}, severity ∈ low|normal|high,
 * suggestedDeadline is a display-only string).
 */
export function buildEscalationFromPremiseEvent(event, { now = Date.now(), deadlineDays = 3 } = {}) {
  if (!event || typeof event !== "object") {
    return { ok: false, reason: "event_missing" };
  }
  const decisionId = event.decision_id;
  if (typeof decisionId !== "string" || !decisionId.trim()) {
    return { ok: false, reason: "decision_id_missing" };
  }
  if (!event.series_fingerprint) {
    // Same rule as the event builder: without the fingerprint the reviewer
    // cannot reconstruct what was evaluated, so the item would be unanswerable.
    return { ok: false, reason: "series_fingerprint_missing" };
  }
  if (typeof event.metric_ref !== "string" || !event.metric_ref.trim()) {
    return { ok: false, reason: "metric_ref_missing" };
  }

  const blind = event.observed_value === null || event.observed_value === undefined;
  const observedText = blind ? "未取得观测值（数据缺口）" : String(event.observed_value);
  const index = Number.isInteger(event.precondition_index) ? event.precondition_index : null;

  const question = (
    `判定 ${decisionId} 的前提${index === null ? "" : ` #${index}`}不再成立：`
    + `${event.metric_ref} 当前 ${observedText}，`
    + `要求 ${event.comparator} ${event.threshold}。是否重新评估该判定？`
  ).slice(0, 500);

  const deadline = new Date(now + deadlineDays * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);

  return {
    ok: true,
    payload: {
      question,
      options: [
        { value: OPTION_REEVALUATE, label: "重新评估该判定（前提已变）" },
        { value: OPTION_HOLD, label: "维持原判定（已知前提失效）" },
      ],
      // 盲区（没有观测值）比越阈更严重：越阈是"事实变了"，盲区是"看不见"。
      severity: blind ? "high" : "normal",
      suggestedDeadline: deadline,
    },
    meta: {
      decision_id: decisionId,
      precondition_index: index,
      metric_ref: event.metric_ref,
      series_fingerprint: event.series_fingerprint,
    },
  };
}

/**
 * Batch: events → escalation payloads. Refuses per-item, never throws.
 * Returns {items, refused, counts, complete}.
 */
export function buildEscalations(events, opts = {}) {
  const items = [];
  const refused = [];
  for (const [i, ev] of (Array.isArray(events) ? events : []).entries()) {
    const res = buildEscalationFromPremiseEvent(ev, opts);
    if (res.ok) {
      items.push({ payload: res.payload, meta: res.meta });
    } else {
      refused.push({ index: i, decision_id: ev?.decision_id ?? null, reason: res.reason });
    }
  }
  const total = Array.isArray(events) ? events.length : 0;
  return {
    items,
    refused,
    counts: { total, built: items.length, refused: refused.length },
    complete: items.length + refused.length === total,
  };
}
