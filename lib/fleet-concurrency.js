// ── Run concurrency ceiling (fleet-run-concurrency) ─────────────────────────
//
// A post may DECLARE any number of parallel runs; how many can actually run is a
// property of the deployment right now, not of the declaration. This module is
// the one place that answers "how many, and which limit decided it" — pure, with
// every input injected, so a test can pin the verdict over synthetic capacities
// instead of needing a live cell.
//
// The failure this exists to prevent, in one line: a post configured for 3 that
// silently runs 1 and reads as healthy. Two numbers are not enough to see that —
// `effective` alone cannot tell "the ceiling is 2" from "the ceiling is 4 but
// only 2 slots are free", and those have opposite fixes. So the result names the
// limit that won.
//
// Absence is a first-class state: an unreadable dimension does NOT quietly
// disappear from the minimum (that would let a broken memory probe read as
// "plenty of room"). It is reported in `unreadable`, and when nothing at all can
// be read the ceiling is `null` — the caller must render a placeholder, never
// fall back to 1.

/** Dimension labels, in the order they are considered (also the tie-break order). */
export const CEILING_DIMENSIONS = Object.freeze(["worker_pool", "fleet_inflight", "admission", "runner_children"]);

/**
 * @param {object} caps
 * @param {number|null} caps.workerCap       全 cell 回合道宽度（TASK_WORKER_MAX，0/未设按 1）
 * @param {number|null} caps.fleetInflight   该舰队在途上限（FLEET_MAX_INFLIGHT）
 * @param {number|null} caps.admissionSlots  内存准入算出的可容纳数
 * @param {number|null} caps.runnerChildren  仅 runner 承载时有意义；其它承载传 null
 * @returns {{ceiling: number|null, limitedBy: string|null, unreadable: string[]}}
 */
// Defaults are `undefined`, NOT null: an omitted dimension means "this deployment
// does not have it", which is inapplicable and must not be reported as unreadable.
// A caller that HAS a dimension but failed to read it passes null explicitly.
export function concurrencyCeiling({ workerCap = undefined, fleetInflight = undefined, admissionSlots = undefined, runnerChildren = undefined } = {}) {
  const provided = { worker_pool: workerCap, fleet_inflight: fleetInflight, admission: admissionSlots, runner_children: runnerChildren };
  const unreadable = [];
  const usable = [];
  for (const dim of CEILING_DIMENSIONS) {
    const raw = provided[dim];
    // `undefined` = this dimension does NOT apply here (the deployment has not
    // enabled it — e.g. no memory probe wired yet, or a non-runner carrier
    // asking about runner_children). `null` = it applies but could not be read.
    // The two are NOT the same fact and must not collapse into one: reporting
    // an inapplicable dimension as unreadable makes every role permanently
    // "unhealthy", which is the恒红 gate this repo keeps paying for.
    if (raw === undefined) continue;
    if (raw === null) {
      unreadable.push(dim);
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      unreadable.push(dim);
      continue;
    }
    // A zero cap means "no slots" (e.g. TASK_WORKER_MAX=0 is the serial default
    // and reads as width 1 at the call site — a literal 0 here means the caller
    // found no capacity at all, so it must clamp to zero, not be ignored).
    usable.push({ dim, n: Math.floor(n) });
  }
  const allApplicable = CEILING_DIMENSIONS.filter((d) => !(d === "runner_children" && (runnerChildren === null || runnerChildren === undefined)));
  if (usable.length === 0) {
    return { ceiling: null, limitedBy: null, unreadable: unreadable.length ? unreadable : [...allApplicable] };
  }
  let winner = usable[0];
  for (const u of usable.slice(1)) if (u.n < winner.n) winner = u;
  return { ceiling: winner.n, limitedBy: winner.dim, unreadable };
}

/**
 * How much of one role's capacity is in use right now, from the engine's task
 * records. Pure: the caller supplies the records (engine.allRecords()).
 *
 * `held` counts RUNNING executions of that (fleetId, memberId); `queued` counts
 * the ones waiting. The two are deliberately separate — a role whose queue is
 * deep and whose held count is pinned at the ceiling is capacity-limited, while
 * one with held < ceiling and a deep queue is waiting on something else. Those
 * have different fixes, so one number would hide the distinction.
 *
 * Records without a sourceTag (chat-lane turns, tool posts, legacy rows) are
 * role-less and never counted.
 */
export function roleLoad(records, { fleetId, memberId } = {}) {
  if (!fleetId || !memberId || !Array.isArray(records)) return { held: 0, queued: 0 };
  let held = 0;
  let queued = 0;
  for (const r of records) {
    const tag = r?.sourceTag;
    if (!tag?.fleetId || !tag?.memberId) continue;
    if (tag.fleetId !== fleetId || tag.memberId !== memberId) continue;
    if (r.state === "running") held += 1;
    else if (r.state === "queued") queued += 1;
  }
  return { held, queued };
}
