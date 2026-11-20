// Unit tests for server/runtime-boot.js — the bounded retry ladder that turns a
// transient cold-start failure into a recovery instead of a terminal degraded
// cell (fix-runtime-boot-self-heal-and-slot-gate).
//
// Nothing here boots the server: the classification, the backoff, and the
// ladder's stop conditions are the whole module, so they are tested with a fake
// clock. The boot path itself is top-level await plus a live bridge and is
// covered by the live check, not by this file.
//
// Run: node --test test/runtime-boot.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  isTransientRuntimeInitError,
  resolveBootRetryPolicy,
  bootRetryDelay,
  scheduleRuntimeBootRetries,
  BOOT_RETRY_CAP_MS,
} = await import("../server/runtime-boot.js");

// ── error classification (task 2.1) ──────────────────────────────────────────
test("classification: exactly the 'not now' shapes are transient", () => {
  const cases = [
    // transient — the next attempt can plausibly differ
    [Object.assign(new Error("initialize timed out after 30000ms"), { name: "RequestTimeoutError" }), true, "handshake timeout"],
    [new Error("initialize timed out after 30000ms"), true, "timeout by message"],
    [new Error("spawn dsh Abandoned on its wall budget"), true, "spawn abandoned"],
    [new Error("no adapter registered for provider \"finddata\""), true, "adapter race"],
    // permanent — a configuration/installation fact; retrying only hides it
    [new Error("profile routes must be exclusive: /api/x claimed by 2 lanes"), false, "route-exclusivity assertion"],
    [Object.assign(new Error("spawn dsh ENOENT"), { code: "ENOENT" }), false, "missing binary"],
    [new Error("something nobody has seen before"), false, "unknown shape is permanent"],
  ];
  for (const [err, expected, label] of cases) {
    assert.equal(isTransientRuntimeInitError(err), expected, `${label} must be ${expected ? "transient" : "permanent"}`);
  }
  // A bare string (some call sites rethrow messages) must classify, not crash.
  assert.equal(isTransientRuntimeInitError("initialize timed out"), true);
  assert.equal(isTransientRuntimeInitError(undefined), false);
});

// ── policy + backoff (task 2.2) ──────────────────────────────────────────────
test("policy: defaults, overrides, and MAX=0 as the off switch", () => {
  assert.deepEqual(resolveBootRetryPolicy({}), { max: 6, baseMs: 10_000, capMs: BOOT_RETRY_CAP_MS });
  assert.deepEqual(resolveBootRetryPolicy({ DSH_BOOT_RETRY_MAX: "3", DSH_BOOT_RETRY_BASE_MS: "500" }), {
    max: 3,
    baseMs: 500,
    capMs: BOOT_RETRY_CAP_MS,
  });
  assert.equal(resolveBootRetryPolicy({ DSH_BOOT_RETRY_MAX: "0" }).max, 0, "0 must survive as a real value, not fall back to the default");
  // Garbage must not silently become "retry forever" or "never retry".
  assert.equal(resolveBootRetryPolicy({ DSH_BOOT_RETRY_MAX: "abc" }).max, 6);
  assert.equal(resolveBootRetryPolicy({ DSH_BOOT_RETRY_BASE_MS: "-5" }).baseMs, 10_000);
});

test("backoff doubles from the base and saturates at the cap", () => {
  const policy = { max: 10, baseMs: 100, capMs: 1_000 };
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((a) => bootRetryDelay(a, policy)), [100, 200, 400, 800, 1_000, 1_000]);
  // A base above the cap is clamped down to the base, never below it.
  assert.equal(bootRetryDelay(9, { baseMs: 5_000, capMs: 1_000 }), 5_000);
});

// ── the ladder ───────────────────────────────────────────────────────────────
// Deterministic clock: the scheduler's timers are ours, and each `runNext()`
// fires the earliest pending one and drains the async attempt it started.
function makeClock() {
  const queue = [];
  let seq = 0;
  return {
    timers: {
      setTimeout(fn, ms) {
        seq += 1;
        const handle = { id: seq, fireAt: ms, fn };
        queue.push(handle);
        return handle;
      },
      clearTimeout(handle) {
        const i = queue.indexOf(handle);
        if (i >= 0) queue.splice(i, 1);
      },
    },
    get pending() {
      return queue.length;
    },
    // Fires the next scheduled callback and returns its delay, or null when idle.
    async runNext() {
      if (queue.length === 0) return null;
      queue.sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
      const handle = queue.shift();
      handle.fn();
      await drain();
      return handle.fireAt;
    },
  };
}

const drain = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

test("MAX=0 schedules nothing at all — the pre-change behavior and the rollback", async () => {
  const clock = makeClock();
  const handle = scheduleRuntimeBootRetries({
    policy: { max: 0, baseMs: 10, capMs: 100 },
    attemptRuntime: async () => {
      throw new Error("must not be attempted");
    },
    isReady: () => false,
    timers: clock.timers,
  });
  assert.equal(clock.pending, 0, "no timer may be armed when the ladder is off");
  assert.equal(handle.running, false);
  assert.equal(handle.attempts, 0);
});

test("a transient failure retries with the backoff sequence and reports onReady once", async () => {
  const clock = makeClock();
  const logs = [];
  const attempts = [];
  let ready = false;
  let readyCalls = 0;

  const handle = scheduleRuntimeBootRetries({
    policy: { max: 4, baseMs: 100, capMs: 1_000 },
    attemptRuntime: async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 3) ready = true; // third attempt heals it
      else throw new Error("initialize timed out after 1000ms");
    },
    isReady: () => ready,
    onReady: () => {
      readyCalls += 1;
    },
    onGiveUp: () => {
      throw new Error("must not give up");
    },
    log: (l) => logs.push(l),
    timers: clock.timers,
  });

  assert.equal(clock.pending, 1, "the first retry is armed at boot-failure time");
  assert.equal(await clock.runNext(), 100, "first delay is the base");
  assert.equal(attempts.length, 1);
  assert.equal(await clock.runNext(), 200, "second delay doubles");
  assert.equal(attempts.length, 2);
  assert.equal(await clock.runNext(), 400, "third delay doubles again");
  assert.equal(readyCalls, 1, "onReady runs exactly once");
  assert.equal(clock.pending, 0, "a recovered ladder arms nothing");
  assert.equal(handle.running, false);
  assert.ok(logs.some((l) => /recovered on retry 3\/4/.test(l)), "the recovery is logged with the attempt count");
  assert.equal(attempts.length, 3);
});

test("a start that resolves but leaves the runtime not ready still counts as a failure", async () => {
  // Half-booted child: `start()` resolved, `isReady()` is still false. Treating
  // that as success would stop the ladder on exactly the state it exists to fix.
  const clock = makeClock();
  const logs = [];
  let ready = false;
  let attempts = 0;

  const handle = scheduleRuntimeBootRetries({
    policy: { max: 2, baseMs: 10, capMs: 100 },
    attemptRuntime: async () => {
      attempts += 1;
      if (attempts === 2) ready = true;
      // attempt 1 resolves without flipping readiness
    },
    isReady: () => ready,
    onReady: () => {},
    onGiveUp: () => {
      throw new Error("must not give up — attempt 2 heals");
    },
    log: (l) => logs.push(l),
    timers: clock.timers,
  });

  await clock.runNext();
  assert.equal(attempts, 1);
  assert.ok(
    logs.some((l) => /resolved but the runtime is still not ready/.test(l)),
    "the halfway state is named in the log",
  );
  await clock.runNext();
  assert.equal(attempts, 2);
  assert.equal(handle.running, false, "the second attempt flipped readiness, so the ladder stops");
  assert.equal(clock.pending, 0);
});

test("a permanent failure stops immediately and never arms another timer", async () => {
  const clock = makeClock();
  const logs = [];
  let gaveUp = null;

  const handle = scheduleRuntimeBootRetries({
    policy: { max: 6, baseMs: 10, capMs: 100 },
    attemptRuntime: async () => {
      throw new Error("profile routes must be exclusive: /api/x claimed by 2 lanes");
    },
    isReady: () => false,
    onReady: () => {
      throw new Error("must not report ready");
    },
    onGiveUp: (err, info) => {
      gaveUp = { message: err.message, ...info };
    },
    log: (l) => logs.push(l),
    timers: clock.timers,
  });

  await clock.runNext();
  assert.deepEqual(gaveUp, {
    message: "profile routes must be exclusive: /api/x claimed by 2 lanes",
    attempts: 1,
    permanent: true,
  });
  assert.equal(clock.pending, 0, "a permanent shape must not be retried");
  assert.equal(handle.running, false);
  assert.ok(logs.some((l) => /retrying would only hide it/.test(l)));
});

test("exhaustion keeps the runtime not ready and reports the real attempt count", async () => {
  const clock = makeClock();
  const logs = [];
  let gaveUp = null;
  let attempts = 0;

  const handle = scheduleRuntimeBootRetries({
    policy: { max: 3, baseMs: 10, capMs: 100 },
    attemptRuntime: async () => {
      attempts += 1;
      throw new Error("initialize timed out after 30000ms");
    },
    isReady: () => false,
    onReady: () => {
      throw new Error("must not report ready");
    },
    onGiveUp: (err, info) => {
      gaveUp = { permanent: info.permanent, attempts: info.attempts, message: err.message };
    },
    log: (l) => logs.push(l),
    timers: clock.timers,
  });

  for (let i = 0; i < 10 && clock.pending > 0; i += 1) await clock.runNext();

  assert.equal(attempts, 3, "the ladder spends exactly `max` attempts");
  assert.deepEqual(gaveUp, { permanent: false, attempts: 3, message: "initialize timed out after 30000ms" });
  assert.equal(clock.pending, 0);
  assert.equal(handle.running, false);
  assert.equal(handle.attempts, 3);
  assert.ok(logs.some((l) => /retries exhausted \(3\/3\)/.test(l)));
});

test("cancel stops the ladder and drops the armed timer", async () => {
  const clock = makeClock();
  let attempts = 0;
  const handle = scheduleRuntimeBootRetries({
    policy: { max: 5, baseMs: 10, capMs: 100 },
    attemptRuntime: async () => {
      attempts += 1;
      throw new Error("initialize timed out after 30000ms");
    },
    isReady: () => false,
    onReady: () => {},
    onGiveUp: () => {},
    timers: clock.timers,
  });

  handle.cancel();
  assert.equal(clock.pending, 0, "cancel clears the pending timer");
  assert.equal(handle.running, false);
  assert.equal(attempts, 0);
});

test("a ladder that finds readiness already true does not attempt anything", async () => {
  // The boot catch and a racing path can both land here; the ladder must not
  // spawn a second child just because it was scheduled.
  const clock = makeClock();
  let attempts = 0;
  scheduleRuntimeBootRetries({
    policy: { max: 2, baseMs: 10, capMs: 100 },
    attemptRuntime: async () => {
      attempts += 1;
    },
    isReady: () => true,
    onReady: () => {
      throw new Error("already ready — must not re-report");
    },
    onGiveUp: () => {},
    timers: clock.timers,
  });
  await clock.runNext();
  assert.equal(attempts, 0);
  assert.equal(clock.pending, 0);
});
