// Pure decision functions for the cron execution lane (harden-cell-execution-
// reliability 3.1: "cron-runner decisions are testable pure functions").
//
// Everything here is a total function of its arguments: no IO, no module
// state, no clock (time enters as a parameter), no imports. The impure
// wrappers own the environment reads, the rule parsing and the default clock:
//   • server/cron-runner.js — the one-hop retry/degrade gates in runPersonaTurn
//   • cron.js — the downtime catch-up window (withinToleranceWindow) and the
//     missed-occurrence walk (countMissedOccurrences)
// Contract tests: scripts/test-cron-decisions.mjs; the live wrappers stay
// pinned by scripts/test-cron-catchup.mjs, scripts/test-fleet-turn-attribution
// .mjs and scripts/test-model-budget-gate.mjs.

// ── One-hop retry/degrade decisions (runPersonaTurn) ─────────────────────────
//
// fix-fleet-turn-attribution D5 / add-model-surface-budget-gate: two gates
// share the same tail — the degrade chain still has an untried hop AND the
// wall clock is still inside the fast-failure window. The window bounds the
// double-budget risk (an upstream 5xx answers in seconds; the work's own
// shape — a real turn, a slow 9k-token answer — must not be re-run late for
// nothing).

// Default fast-failure window: 60s. PLATFORM_LLM_RETRY_FAST_MS overrides.
export const RETRY_FAST_DEFAULT_MS = 60_000;

// The fast-failure window in ms: a positive PLATFORM_LLM_RETRY_FAST_MS wins,
// anything else (unset, garbage, 0, negative) falls back to the default — a
// mistyped deployment must neither disable nor unbound the window.
export function retryFastWindowMs(env) {
  const n = Number(env?.PLATFORM_LLM_RETRY_FAST_MS);
  return n > 0 ? n : RETRY_FAST_DEFAULT_MS;
}

// The shared tail of both one-hop gates: the chain still has an untried hop
// (candidates is the ordered degrade chain, landedIndex the hop that ran) and
// the turn is still inside the fast-failure window. The window boundary is
// EXCLUSIVE: elapsed == window is already too late.
export function fastWindowWithUntriedHop({ elapsedMs, retryFastMs, candidates, landedIndex }) {
  return elapsedMs < retryFastMs && Array.isArray(candidates) && landedIndex + 1 < candidates.length;
}

// The one-hop fast-failure retry gate: a FAST upstream-class failure may retry
// ONCE on the next candidate. Timeouts and tool failures are the work's own
// shape — another model would hit them too. `errorKind` is
// classifyErrorKind(result.error), computed by the caller so this module stays
// dependency-free; `elapsedMs` is the caller's wall-clock delta (startedWall →
// now). `result` is the attempt outcome ({ ok, interrupted?, ... }).
export function shouldRetryFastFailure({ result, errorKind, elapsedMs, retryFastMs, candidates, landedIndex }) {
  return result?.ok === false
    && result?.interrupted !== true
    && errorKind === "model_upstream"
    && fastWindowWithUntriedHop({ elapsedMs, retryFastMs, candidates, landedIndex });
}

// The single-tier budget gate (add-model-surface-budget-gate, spec 单次超限走
// 降级链): the turn SUCCEEDED but blew the per-turn token cap — the same
// one-hop degrade the upstream-failure retry rides, gated on the same
// untried-hop + fast-window conditions. `tokens` is turnTokens(result?.usage)
// (null = honest absence of usage); `singleCap` is the deployment's per-turn
// cap — absent resolves to Infinity, i.e. never over.
export function shouldDegradeOverBudget({ result, tokens, singleCap, elapsedMs, retryFastMs, candidates, landedIndex }) {
  return result?.ok === true
    && result?.interrupted !== true
    && tokens != null
    && tokens > (singleCap ?? Infinity)
    && fastWindowWithUntriedHop({ elapsedMs, retryFastMs, candidates, landedIndex });
}

// ── Downtime catch-up decisions (cron.js) ────────────────────────────────────
//
// P2 (2026-10-26): a restart covering a cron trigger lost a patrol silently.
// The catch-up rule — ONE make-up run while the downtime gap is still inside
// the tolerance window — is decided here as pure math so the boot pass, the
// interrupted-beat makeup (makeUpInterruptedBeat) and the contract tests read
// the same verdict.

// The window floor: short-cadence posts (hourly and denser) still get a 6h
// make-up horizon — 2 × a 1h period would render most downtime gaps past
// saving before a restart even finishes.
export const CATCH_UP_FLOOR_MS = 6 * 60 * 60 * 1000;

// The tolerance window for a downtime gap: 2 × cadence period, floored at 6h.
// A period the parser could not produce (non-finite / non-positive) falls
// back to the floor — never suppress a catch-up on a rule the scheduler
// accepted.
export function catchUpWindowMs(periodMs) {
  return Number.isFinite(periodMs) && periodMs > 0
    ? Math.max(2 * periodMs, CATCH_UP_FLOOR_MS)
    : CATCH_UP_FLOOR_MS;
}

// The full catch-up verdict. The wrapper in cron.js maps the live record onto
// these inputs:
//   killSwitch — PLATFORM_CRON_CATCHUP=0 → the make-up is suppressed before
//                anything else is even looked at (including a broken rule).
//   windowMs   — the computed tolerance window; null encodes "the rule failed
//                to parse here" → degrade OPEN (true): never suppress a
//                make-up on a rule the scheduler itself accepted.
//   lastRunMs  — the task's last fire as a timestamp; null/NaN = the task
//                never ran — no "missed round" to make up (it is simply
//                starting; its first occurrence is still ahead).
//   nowMs      — the decision clock (injected: no hidden Date.now()).
// The window compare is INCLUSIVE at the boundary: a gap of exactly the
// window is still inside it.
export function withinCatchUpWindow({ killSwitch, windowMs, lastRunMs, nowMs }) {
  if (killSwitch) return false;
  if (windowMs == null) return true; // unparseable rule: degrade open
  if (lastRunMs == null || !Number.isFinite(lastRunMs)) return false;
  return nowMs - lastRunMs <= windowMs;
}

// ── Missed-occurrence accounting (cron.js load-time downtime pass) ───────────

// Missed-occurrence accounting caps iteration at this many gaps per load so a
// task left dead for years cannot spin the parser.
export const MAX_MISSED_PER_LOAD = 100;

// The counting core of cron.js's downtime accounting: occurrences strictly
// between `fromMs` (the task's last fire) and the iterator's anchor count as
// missed, capped at `cap`. `iter` is a cron-parser expression iterator — an
// input, not a dependency: the anchor (the decision "now") was fixed by the
// caller's parse, so the walk itself has no clock. Not defensive about a
// missing iter: a malformed call throws into the caller's degrade-open catch,
// exactly like the inline walk it replaced. The caller owns record mutation
// (missed counter, lastMissedAt/Reason, history marker) and logging.
export function countMissedBetween(iter, fromMs, cap = MAX_MISSED_PER_LOAD) {
  let missed = 0;
  // prev() yields occurrences strictly before the anchor (most recent first);
  // each one after lastRun was entirely covered by downtime. No warm-up call —
  // the first prev() is itself a countable occurrence.
  let prev = iter.prev();
  while (prev && prev.toDate().getTime() > fromMs && missed < cap) {
    missed++;
    prev = iter.prev();
  }
  return missed;
}
