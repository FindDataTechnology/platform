// Decision ledger emission from the fleet decision lane
// (generalize-decision-contract 7.1 / 7.2).
//
// What this is for: a resolved 拍板项 is a decision made by a human (or a
// delegated deputy). Until now it lived only in the fleet queue — nothing
// downstream could settle it, so "was that call right?" had no answer.
//
// Two hard constraints, both from the change's spec:
//
//   7.1 opt-in, default OFF. Emitting to the ledger is a new outbound
//       dependency; a fleet that has not opted in must behave byte-identically
//       to before. `emitEnabled()` is the single switch.
//
//   7.2 a ledger outage MUST NOT roll back the approval. The approval has
//       already been written and is the human's actual act; losing it because
//       a downstream bookkeeping service was down would be the worst possible
//       trade. So sends are fire-and-record: a failure lands in an outbox row
//       for retry, and the caller is never thrown at.

export const EMIT_ENV = "FD_DECISION_LEDGER_EMIT";

// Which resolution kinds produce a ledger decision. `reject` is a real
// decision (the owner said no) and therefore settleable too.
const EMITTABLE_KINDS = new Set(["approve", "amend", "reject"]);

/** Is emission enabled? Default off; opt in with FD_DECISION_LEDGER_EMIT=1. */
export function emitEnabled(env = process.env) {
  return String(env?.[EMIT_ENV] ?? "") === "1";
}

/**
 * Map a resolved decision item to a Decision v2 payload.
 *
 * Returns {ok:true, payload} or {ok:false, reason}. A refusal is not an
 * error: most items simply have no settleable outcome (e.g. "restart this
 * post"), and emitting a decision with no measurable outcome would put
 * unsettleable rows in the ledger forever.
 */
export function buildDecisionFromResolution({ item, fleet, resolution, now }) {
  if (!item || typeof item !== "object") {
    return { ok: false, reason: "item_missing" };
  }
  const kind = resolution?.kind ?? null;
  if (!EMITTABLE_KINDS.has(kind)) {
    return { ok: false, reason: `resolution_kind_not_emittable:${kind}` };
  }

  // The settleable shape has to be declared by whoever raised the item:
  // without an expected outcome there is nothing to settle against later,
  // and inventing one here would manufacture a metric that was never agreed.
  const settle = item.detail?.settlement ?? null;
  if (!settle || typeof settle !== "object") {
    return { ok: false, reason: "no_settlement_spec" };
  }
  const metricRef = settle.metric_ref;
  const comparator = settle.comparator;
  const threshold = settle.threshold;
  if (typeof metricRef !== "string" || !metricRef.trim()) {
    return { ok: false, reason: "settlement_metric_ref_missing" };
  }
  if (!["gt", "gte", "lt", "lte", "eq", "neq"].includes(comparator)) {
    return { ok: false, reason: `settlement_comparator_invalid:${comparator}` };
  }
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    return { ok: false, reason: "settlement_threshold_not_numeric" };
  }

  const choice = resolution?.choice ?? (kind === "reject" ? "reject" : null);
  const asOf = new Date(now ?? Date.now()).toISOString().slice(0, 10);

  const payload = {
    schema_version: "2",
    as_of: asOf,
    subject: String(item.id ?? item.itemId ?? ""),
    subject_kind: settle.subject_kind ?? "contract",
    action: String(choice ?? "reject"),
    preconditions: Array.isArray(item.detail?.preconditions)
      ? item.detail.preconditions
      : [],
    settlement_rule_id: "metric_threshold",
    expected_outcome: {
      metric_ref: metricRef,
      comparator,
      threshold,
      horizon: settle.horizon ?? { unit: "month", count: 3 },
      settlement_source: "caller_supplied_series",
    },
    basis: String(resolution?.note ?? item.question ?? "").slice(0, 2000),
    evidence: [],
    producer: {
      pack: "paas/fleet-decision-lane",
      skill: String(item.category ?? "routine-ops"),
      run_id: String(item.id ?? item.itemId ?? ""),
    },
  };
  // provenance stays outside the contract payload (the contract has no field
  // for it, and adding one silently would be schema drift)
  return { ok: true, payload, provenance: { fleetId: fleet?.id ?? null, resolvedBy: resolution?.by ?? null } };
}

/**
 * Deliver a decision, or park it for retry. NEVER throws.
 *
 * `send` is injected so tests (and any worker) can substitute transport.
 * Returns {delivered, queued, error}. The caller's approval is already
 * persisted by the time this runs, so a failure here is recorded, not raised.
 */
export async function emitDecision({ payload, send, outbox }) {
  try {
    const result = await send(payload);
    return { delivered: true, queued: false, error: null, result };
  } catch (err) {
    const error = String(err?.message ?? err).slice(0, 2000);
    // 7.2: retryable, never blocking. An outbox row is the record; a raised
    // exception here would be turned into a 5xx by the route and the owner
    // would believe the approval failed.
    try {
      outbox?.push?.({ payload, error, attempts: 1, queuedAt: Date.now() });
    } catch {
      // an outbox failure must not become the approval's failure either
    }
    return { delivered: false, queued: true, error };
  }
}

/**
 * Drain an outbox through `send`, keeping the rows that still fail.
 * Returns {sent, remaining}. Also never throws.
 */
export async function flushOutbox({ outbox, send }) {
  if (!Array.isArray(outbox) || outbox.length === 0) {
    return { sent: 0, remaining: [] };
  }
  const remaining = [];
  let sent = 0;
  for (const row of outbox) {
    try {
      await send(row.payload);
      sent += 1;
    } catch (err) {
      remaining.push({
        ...row,
        attempts: (row.attempts ?? 1) + 1,
        error: String(err?.message ?? err).slice(0, 2000),
      });
    }
  }
  return { sent, remaining };
}
