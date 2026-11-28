// ── Concurrency read face (fleet-run-concurrency 3.1 / 3.2) ─────────────────
//
// One projection, two callers: the member view (per post, in the cockpit) and the
// readiness probe (every post, for the cluster). Keeping it in one function is
// what stops the two faces answering the same question differently — the exact
// drift the "declared / ceiling / effective" split exists to expose.
//
// Four numbers, never two: a reader must be able to tell
//   · "the operator asked for 1"          (declared)
//   · "this deployment tops out at 2"     (ceiling)
//   · "so it runs 2"                      (effective)
//   · "and here is what capped it"        (limitedBy)
// apart. With only `declared` and `effective`, "the ceiling is 2" and "the
// ceiling is 4 but only 2 slots are free" read identical — and they have
// opposite fixes.
//
// Absence is reported, never zeroed: an unreadable ceiling says `unknown` with a
// reason. A post that cannot be measured is not a post with nothing running.

import { concurrencyCeiling, roleLoad } from "../lib/fleet-concurrency.js";

export function buildConcurrencyView(member, fleet, { records = [], env = process.env } = {}) {
  // Declared: the first layer in member → fleet → deployment that says anything.
  const memberConc = Number.isInteger(member?.concurrency) ? member.concurrency : null;
  const fleetConc = fleet?.orchestration?.constraints?.concurrency;
  const envConc = Number(env.CELL_CONCURRENCY_DEFAULT);
  const declared = memberConc
    ?? (Number.isInteger(fleetConc) && fleetConc > 0 ? fleetConc : null)
    ?? (Number.isInteger(envConc) && envConc > 0 ? envConc : null)
    ?? 1;
  const source = memberConc !== null ? "member"
    : (Number.isInteger(fleetConc) && fleetConc > 0) ? "fleet"
      : (Number.isInteger(envConc) && envConc > 0) ? "deployment" : "default";

  const workbench = member?.workbench ?? fleet?.orchestration?.constraints?.workbench ?? "off";

  // Capacity, read live. worker_pool: TASK_WORKER_MAX, 0/unset/invalid reads as
  // width 1 (the serial default the pool itself falls back to). fleet_inflight:
  // FLEET_MAX_INFLIGHT, default 4, matching the pool's own default.
  let ceiling = null;
  let limitedBy = null;
  let unreadable = [];
  try {
    const rc = Number(env.TASK_WORKER_MAX);
    const workerCap = Number.isInteger(rc) && rc > 0 ? rc : 1;
    const fi = Number(env.FLEET_MAX_INFLIGHT);
    const fleetInflight = Number.isInteger(fi) && fi > 0 ? fi : 4;
    const c = concurrencyCeiling({ workerCap, fleetInflight });
    ceiling = c.ceiling;
    limitedBy = c.limitedBy;
    unreadable = c.unreadable;
  } catch (e) {
    return {
      declared,
      source,
      workbench,
      ceiling: { unknown: true, reason: `ceiling unavailable: ${e?.message || e}` },
      effective: null,
      limitedBy: null,
      held: null,
      queued: null,
      unreadable: ["ceiling"],
    };
  }

  const effective = ceiling === null ? null : Math.min(declared, ceiling);
  const load = roleLoad(records, { fleetId: member?.fleetId, memberId: member?.id });
  return { declared, source, workbench, ceiling, effective, limitedBy, held: load.held, queued: load.queued, unreadable };
}
