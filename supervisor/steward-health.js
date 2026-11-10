// ── Steward crash-loop guard (add-desktop-residency-hardening 2.x) ─────────
//
// The OS registration respawns the resident steward unconditionally (macOS
// LaunchAgent KeepAlive, Windows schtasks ONLOGON). A broken build therefore
// turns into an infinite respawn loop that never surfaces: the user sees
// nothing, the machine burns CPU, and the fleet looks "installed" while
// nothing serves.
//
// The guard turns that loop into a REPORTED state:
//   - a boot attempt that fails counts as a failure (with the reason);
//   - reaching the threshold opens a COOLDOWN window: the steward stays alive
//     but starts NO stack (so the OS has nothing to respawn) and reports the
//     failure instead of hiding it;
//   - a healthy boot clears the counter — a slow start is not a failure;
//   - an explicit user action (repair / start now) clears the counter and
//     retries immediately.
//
// State is persisted next to the data root (`steward-health.json`) so a crash
// that kills the process still counts against the next boot.

import fs from "node:fs";
import path from "node:path";

const HEALTH_FILE = "steward-health.json";

export const CRASH_DEFAULTS = {
  // Consecutive failed boots before the cooldown opens. Three keeps a slow
  // cold start (dsh load) from tripping it while still catching a bad build
  // on the second or third attempt.
  threshold: 3,
  // How long the stack stays dark after the threshold is reached.
  cooldownMs: 5 * 60 * 1000,
  // A boot that stayed healthy this long resets the counter.
  resetMs: 60 * 1000,
};

export function createCrashGuard({
  dataDir,
  threshold = CRASH_DEFAULTS.threshold,
  cooldownMs = CRASH_DEFAULTS.cooldownMs,
  resetMs = CRASH_DEFAULTS.resetMs,
  now = () => Date.now(),
  log = console,
} = {}) {
  const file = dataDir ? path.join(dataDir, HEALTH_FILE) : null;

  function read() {
    if (!file) return { failures: 0, lastFailure: null, cooldownUntil: 0, lastSuccessAt: 0 };
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        failures: Number(doc?.failures) || 0,
        lastFailure: doc?.lastFailure ?? null,
        cooldownUntil: Number(doc?.cooldownUntil) || 0,
        lastSuccessAt: Number(doc?.lastSuccessAt) || 0,
      };
    } catch {
      // Absent or unreadable = no history (a first boot is not a failure).
      return { failures: 0, lastFailure: null, cooldownUntil: 0, lastSuccessAt: 0 };
    }
  }

  function write(state) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    } catch (e) {
      log?.warn?.(`[steward-health] could not persist state: ${e?.message || e}`);
    }
  }

  function status() {
    const state = read();
    const cooling = state.cooldownUntil > now();
    return {
      failures: state.failures,
      threshold,
      lastFailure: state.lastFailure,
      cooldownUntil: state.cooldownUntil || null,
      coolingDown: cooling,
      retryAfterMs: cooling ? Math.max(0, state.cooldownUntil - now()) : 0,
      lastSuccessAt: state.lastSuccessAt || null,
    };
  }

  // A boot attempt. Returns false when the cooldown is still open — the
  // caller must NOT start the stack in that case.
  function recordStart() {
    const state = read();
    if (state.cooldownUntil > now()) {
      const retryAfterMs = state.cooldownUntil - now();
      log?.warn?.(
        `[steward-health] cooldown active — not starting the stack (${Math.ceil(retryAfterMs / 1000)}s left, ${state.failures} failed boots)`,
      );
      return { allowed: false, reason: "cooldown", retryAfterMs, status: status() };
    }
    return { allowed: true, reason: null, retryAfterMs: 0, status: status() };
  }

  // The stack came up and stayed up — the counter resets (a healthy boot
  // after a bad one proves the build works again).
  function recordHealthy() {
    const state = read();
    write({ failures: 0, lastFailure: state.lastFailure, cooldownUntil: 0, lastSuccessAt: now() });
    return status();
  }

  // A boot attempt failed: count it, and open the cooldown at the threshold.
  function recordFailure(message) {
    const state = read();
    const failures = state.failures + 1;
    const cooling = failures >= threshold;
    const next = {
      failures,
      lastFailure: { message: String(message ?? "unknown failure").slice(0, 300), at: now() },
      cooldownUntil: cooling ? now() + cooldownMs : state.cooldownUntil,
      lastSuccessAt: state.lastSuccessAt,
    };
    write(next);
    log?.warn?.(
      `[steward-health] boot failed (${failures}/${threshold})${cooling ? " — cooldown opened" : ""}: ${next.lastFailure.message}`,
    );
    return status();
  }

  // An explicit user action (repair / start now) resets the history and
  // retries immediately — the human is in the loop, so the guard stands down.
  function clear() {
    write({ failures: 0, lastFailure: null, cooldownUntil: 0, lastSuccessAt: now() });
    return status();
  }

  // A boot that stayed healthy for resetMs counts as healthy even if the
  // process is restarted later for unrelated reasons.
  function maybeResetByUptime() {
    const state = read();
    if (state.failures > 0 && state.lastSuccessAt && now() - state.lastSuccessAt >= resetMs) {
      return recordHealthy();
    }
    return status();
  }

  return { status, recordStart, recordHealthy, recordFailure, clear, maybeResetByUptime, file };
}
