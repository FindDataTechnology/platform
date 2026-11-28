// Boot-time supervision of the shared agent runtime.
//
// Why this module exists (2026-11-15, cell 1da519d4c1c0bf89): the boot handshake
// needs 33.8s on a cold child (13 MCP servers / 93 presets / 590 tool
// descriptions) while `INIT_TIMEOUT_MS` defaults to 30s, so the first attempt
// failed, the boot catch degraded the cell, and NOTHING retried. The shared
// runtime then reported `isReady() === false` for half an hour: the serial chain
// re-enqueued every round (`the agent runtime is not ready (waited for fleet
// round)`) and the worker pool settled every round as interrupted, until a
// human recreated the pod. A transient timeout is not a terminal state; this
// module owns the bounded ladder that makes it recoverable, and the
// transient/permanent split that keeps a genuinely broken config from being
// retried forever.
//
// Kept out of server.js so the classification and the backoff are unit-testable
// without booting the server (the boot path is top-level await + a live bridge).

// Retry only the shapes that say "not now" rather than "not ever":
//   * the initialize handshake timing out under boot contention,
//   * a spawn abandoned on its wall budget (a wedged child, not a bad config),
//   * the adapter-registration race (`no adapter registered for provider`) the
//     bridge already retries internally.
// Everything else — the profile route-exclusivity assertion, a missing `dsh`
// command, a syntax error in a patch — is a configuration/installation fact.
// Retrying those only floods the log and dresses "configured wrong" up as
// "recovering", so the unknown direction is deliberately PERMANENT: a missed
// transient costs a second look at the logs, a retried permanent error hides a
// real fault.
const TRANSIENT_INIT_PATTERNS = [
  /timed out/i,
  /\bAbandoned\b/,
  /no adapter registered for provider/i,
];

export function isTransientRuntimeInitError(err) {
  const name = String(err?.name || "");
  if (name === "RequestTimeoutError") return true;
  const msg = String(err?.message ?? err ?? "");
  return TRANSIENT_INIT_PATTERNS.some((re) => re.test(msg));
}

// Attempts and spacing for the boot ladder. `DSH_BOOT_RETRY_MAX=0` restores the
// pre-change behavior exactly (fail once, stay degraded) — that is also the
// rollback and the arm a self-check needs to prove the retry is what heals.
export const BOOT_RETRY_CAP_MS = 300_000;

export function resolveBootRetryPolicy(env = process.env) {
  const rawMax = Number(env?.DSH_BOOT_RETRY_MAX);
  const max = Number.isFinite(rawMax) && rawMax >= 0 ? Math.floor(rawMax) : 6;
  const rawBase = Number(env?.DSH_BOOT_RETRY_BASE_MS);
  const baseMs = Number.isFinite(rawBase) && rawBase > 0 ? Math.floor(rawBase) : 10_000;
  return { max, baseMs, capMs: BOOT_RETRY_CAP_MS };
}

// Exponential, capped. `attempt` is 0-based: the delay before the first retry.
export function bootRetryDelay(attempt, policy) {
  const base = Math.max(1, policy?.baseMs ?? 10_000);
  const cap = Math.max(base, policy?.capMs ?? BOOT_RETRY_CAP_MS);
  return Math.min(cap, base * 2 ** Math.max(0, attempt));
}

/**
 * Schedule the bounded retry ladder for a failed runtime start.
 *
 * Contract (the caller owns the readiness bit):
 *   - `attemptRuntime()` performs one full start attempt and THROWS on failure;
 *     resolving is not enough, `isReady()` is the only success signal (a start
 *     that resolves without readiness is treated as a failure — otherwise a
 *     half-booted child would silently stop the ladder).
 *   - success  -> `onReady()` runs exactly once, ladder stops.
 *   - retryable failure with attempts left -> one more scheduled attempt.
 *   - permanent failure OR attempts exhausted -> `onGiveUp(err, { attempts, permanent })`,
 *     ladder stops. Readiness stays false; the caller keeps the operator-visible
 *     error. Never reported as ready.
 *   - `max === 0` -> nothing is scheduled at all.
 *
 * Timers are injected so tests can drive the ladder deterministically; the
 * returned handle's `cancel()` is what a shutdown path would use.
 */
export function scheduleRuntimeBootRetries({
  policy,
  attemptRuntime,
  isReady,
  onReady,
  onGiveUp,
  log = () => {},
  timers = { setTimeout, clearTimeout },
}) {
  const resolved = policy ?? resolveBootRetryPolicy();
  let attempts = 0;
  let handle = null;
  let cancelled = false;
  let done = false;

  const finish = () => {
    done = true;
    if (handle) {
      timers.clearTimeout(handle);
      handle = null;
    }
  };

  const fire = async () => {
    handle = null;
    if (cancelled || done) return;
    if (isReady()) {
      finish();
      return;
    }
    attempts += 1;
    // A start that resolved without flipping readiness is OUR failure to
    // classify, not the child's: it must stay retryable (the next attempt very
    // much can differ — that is the half-booted-child shape), so it is flagged
    // here instead of being routed through the classifier, which would call an
    // unknown message permanent.
    let notReadyAfterStart = false;
    try {
      await attemptRuntime();
      if (!isReady()) {
        notReadyAfterStart = true;
        throw new Error("runtime start resolved but the runtime is still not ready");
      }
      finish();
      log(`[dsh] runtime boot recovered on retry ${attempts}/${resolved.max}`);
      onReady?.();
    } catch (err) {
      const transient = notReadyAfterStart || isTransientRuntimeInitError(err);
      if (!transient) {
        finish();
        log(
          `[dsh] runtime boot retry abandoned after ${attempts}/${resolved.max}: ` +
            `${err?.message || err} — not a transient shape, retrying would only hide it`,
        );
        onGiveUp?.(err, { attempts, permanent: true });
        return;
      }
      if (attempts >= resolved.max) {
        finish();
        log(
          `[dsh] runtime boot retries exhausted (${attempts}/${resolved.max}): ` +
            `${err?.message || err} — the runtime stays not ready`,
        );
        onGiveUp?.(err, { attempts, permanent: false });
        return;
      }
      // `attempts` is the number just spent, so this is the delay before the
      // NEXT attempt: index 0 is the boot-failure arm, index 1 the first retry
      // after a failed retry, and so on — the sequence strictly doubles.
      const delay = bootRetryDelay(attempts, resolved);
      log(
        `[dsh] runtime boot retry ${attempts}/${resolved.max} failed: ${err?.message || err}; ` +
          `next attempt in ${delay}ms`,
      );
      handle = timers.setTimeout(() => {
        void fire();
      }, delay);
    }
  };

  if (resolved.max > 0) {
    handle = timers.setTimeout(() => {
      void fire();
    }, bootRetryDelay(0, resolved));
  } else {
    // `MAX=0` is "off", not "idle": the handle must not claim it is running, or
    // a caller would wait for a recovery that was never scheduled.
    done = true;
  }

  return {
    cancel() {
      cancelled = true;
      finish();
    },
    get attempts() {
      return attempts;
    },
    get running() {
      return !done && !cancelled;
    },
  };
}
