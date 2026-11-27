// Bounded self-retry for a parked catalog-preset roster restart
// (openspec/changes/fix-catalog-preset-roster-convergence).
//
// Why this exists: a roster rewrite only reaches the runtime through a child
// restart, and a restart that collides with another deferred restart (measured
// 2026-11-14: the skills-patch restart spawning generation N vs this one) is
// parked as pending and — before this — waited SOLELY for the next ready/idle
// transition. When no such transition follows, the cell believes in an agent the
// runtime never got: getAgentPresets() answers [] and every switch fails with
// "No agent modes are available in this deployment", built-in standard included.
//
// TWO different reasons to look again, with two different allowances:
//
//   • A FAILED restart (the bridge refused or the spawn did not deliver) is a
//     symptom: it gets a small budget (3) and then stops, so a real fault cannot
//     turn into a spin.
//   • A DECLINE ("the runtime is busy", "the bridge is not ready") is not a
//     symptom at all — nothing was attempted. Charging declines to the failure
//     budget is what lost the roster for good in the 2026-11-14 full run: three
//     looks landed inside one long busy stretch, exhaustion was logged, and the
//     pending rewrite then waited for a transition that the same busy stretch
//     guaranteed would not come until the test's 90s window had expired. A
//     decline therefore keeps looking on the same 5s cadence under its own much
//     larger allowance (10 minutes of busy is still just 120 cheap checks that
//     return immediately when there is nothing to do).
//
// This module is the policy alone — no timers of its own, no imports from the
// session module — so the allowances, the reset-on-new-change rule and the
// "stop, do not spin" rule are testable without a runtime
// (scripts/test-catalog-restart-retry.mjs).

export const CATALOG_RESTART_RETRY_MS = 5_000;
export const CATALOG_RESTART_MAX_ATTEMPTS = 3;
// 5s × 120 = 10 minutes. Long enough to outlast a busy stretch (a turn, a
// collector lane, a reservation) and short enough that a runtime which never
// idles stops costing timer wakeups.
export const CATALOG_RESTART_MAX_LOOKS = 120;

/**
 * @param {object} opts
 * @param {(fn: () => void, ms: number) => any} opts.setTimer   injected so tests are deterministic
 * @param {(handle: any) => void} opts.clearTimer
 * @param {() => void} opts.onRetry        called when an allowance remains
 * @param {(info: {attempts: number, looks: number, reason: string}) => void} [opts.onExhausted]
 * @param {number} [opts.delayMs]
 * @param {number} [opts.maxAttempts]      failed-restart allowance
 * @param {number} [opts.maxLooks]         decline allowance
 */
export function createCatalogRestartRetry({
  setTimer,
  clearTimer,
  onRetry,
  onExhausted,
  delayMs = CATALOG_RESTART_RETRY_MS,
  maxAttempts = CATALOG_RESTART_MAX_ATTEMPTS,
  maxLooks = CATALOG_RESTART_MAX_LOOKS,
}) {
  let attempts = 0;
  let looks = 0;
  let handle = null;

  const cancel = () => {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };

  // One timer, never a pile: two declines in the same window share the look
  // that is already scheduled.
  const schedule = () => {
    if (handle === null) {
      handle = setTimer(() => {
        handle = null;
        onRetry();
      }, delayMs);
    }
    return { scheduled: true, attempts, looks, remaining: maxAttempts - attempts, looksRemaining: maxLooks - looks };
  };

  return {
    /**
     * The runtime could not take the rewrite yet (busy / bridge not ready). This
     * is NOT a failed restart — nothing was attempted — so it draws on the look
     * allowance, not the failure budget.
     */
    noteDeferred(reason = "deferred") {
      if (handle !== null) return schedule();
      if (looks >= maxLooks) {
        onExhausted?.({ attempts, looks, maxLooks, reason });
        return { scheduled: false, attempts, looks, remaining: maxAttempts - attempts, looksRemaining: 0 };
      }
      looks += 1;
      return schedule();
    },

    /** A restart attempt failed: count it and schedule the next one while the budget lasts. */
    noteFailure() {
      attempts += 1;
      if (handle !== null) return schedule();
      if (attempts >= maxAttempts) {
        // Stop here and leave the pending flag for the next runtime transition.
        // A tight loop on a failing restart would spin (see the caller's comment).
        onExhausted?.({ attempts, looks, maxAttempts, reason: "restart failed" });
        return { scheduled: false, attempts, looks, remaining: 0, looksRemaining: maxLooks - looks };
      }
      return schedule();
    },

    /** Delivered: both allowances and any queued retry go away. */
    noteSuccess() {
      attempts = 0;
      looks = 0;
      cancel();
    },

    /** A new catalog change is a new delivery episode — the old allowances must not starve it. */
    reset() {
      attempts = 0;
      looks = 0;
      cancel();
    },

    /** Observable for tests/diagnostics. */
    get state() {
      return { attempts, looks, pending: handle !== null, maxAttempts, maxLooks };
    },
  };
}
