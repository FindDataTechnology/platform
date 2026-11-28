#!/usr/bin/env node
// Deterministic test for the parked-roster-restart retry policy
// (openspec/changes/fix-catalog-preset-roster-convergence, tasks 3.2/3.3).
//
// No runtime, no timers: the policy takes its timer from the caller, so every
// case below is exact. The e2e reproducer (custom-presets → focus-overlay) is
// probabilistic — it needs a real restart collision — so it cannot carry this
// verdict on its own; these cases do.
//
// Run: node scripts/test-catalog-restart-retry.mjs

import assert from "node:assert/strict";
import {
  CATALOG_RESTART_MAX_ATTEMPTS,
  CATALOG_RESTART_MAX_LOOKS,
  createCatalogRestartRetry,
} from "../lib/catalog-restart-retry.js";

function harness({ maxAttempts = CATALOG_RESTART_MAX_ATTEMPTS, maxLooks = CATALOG_RESTART_MAX_LOOKS } = {}) {
  const queued = [];
  const retried = [];
  const exhausted = [];
  const policy = createCatalogRestartRetry({
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      queued.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
    onRetry: () => retried.push(Date.now()),
    onExhausted: (info) => exhausted.push(info),
    maxAttempts,
    maxLooks,
  });
  const fire = () => {
    const next = queued.find((h) => !h.cleared && !h.fired);
    assert.ok(next, "expected a queued retry to fire");
    next.fired = true;
    next.fn();
    return next;
  };
  return { policy, queued, retried, exhausted, fire };
}

// 1. A failure schedules exactly one retry, not more (no pile-up on repeat calls).
{
  const { policy, queued } = harness();
  const first = policy.noteFailure();
  assert.equal(first.scheduled, true);
  assert.equal(queued.length, 1);
  const second = policy.noteFailure();
  assert.equal(second.scheduled, true, "still inside the budget ⇒ reported as scheduled (already queued)");
  assert.equal(queued.length, 1, "must not queue a second timer while one is pending");
}

// 2. The retry actually runs when its timer fires.
{
  const { policy, retried, fire } = harness();
  policy.noteFailure();
  fire();
  assert.equal(retried.length, 1, "timer fire must call onRetry");
  assert.deepEqual(policy.state, { attempts: 1, looks: 0, pending: false, maxAttempts: CATALOG_RESTART_MAX_ATTEMPTS, maxLooks: CATALOG_RESTART_MAX_LOOKS });
}

// 3. Bounded: after maxAttempts failures it stops and reports exhaustion — never spins.
{
  const rounds = CATALOG_RESTART_MAX_ATTEMPTS;
  const { policy, retried, exhausted, fire } = harness();
  for (let i = 0; i < rounds; i++) {
    policy.noteFailure();
    if (i < rounds - 1) fire();
  }
  assert.equal(retried.length, rounds - 1, `retries stop at ${rounds - 1} (the last failure exhausts the budget)`);
  assert.equal(exhausted.length, 1, "exhaustion is reported once, so the caller can log why it stopped");
  assert.deepEqual(policy.state, { attempts: rounds, looks: 0, pending: false, maxAttempts: rounds, maxLooks: CATALOG_RESTART_MAX_LOOKS });

  // Another failure after exhaustion must NOT schedule anything (that would be the spin).
  policy.noteFailure();
  assert.equal(exhausted.length, 2, "each further failure reports exhaustion once");
  assert.equal(policy.state.pending, false, "no timer after exhaustion");
}

// 4. Success clears both the budget and any queued retry (a delivered roster
//    must not restart the runtime again five seconds later).
{
  const { policy, queued, retried, fire } = harness();
  policy.noteFailure();
  policy.noteSuccess();
  assert.deepEqual(policy.state, { attempts: 0, looks: 0, pending: false, maxAttempts: CATALOG_RESTART_MAX_ATTEMPTS, maxLooks: CATALOG_RESTART_MAX_LOOKS });
  assert.equal(queued[0].cleared, true, "the queued retry must be cancelled");
  assert.throws(() => fire(), /expected a queued retry/, "nothing left to fire");
  assert.equal(retried.length, 0);
}

// 5. A NEW catalog change resets the budget: an exhausted episode must not
//    starve the next one (measured shape: catalog churns 1 → 0 → 1 in a run).
{
  const rounds = CATALOG_RESTART_MAX_ATTEMPTS;
  const { policy, exhausted, fire } = harness();
  for (let i = 0; i < rounds; i++) {
    policy.noteFailure();
    if (i < rounds - 1) fire();
  }
  assert.equal(exhausted.length, 1);
  policy.reset();
  assert.deepEqual(policy.state, { attempts: 0, looks: 0, pending: false, maxAttempts: rounds, maxLooks: CATALOG_RESTART_MAX_LOOKS });
  const after = policy.noteFailure();
  assert.equal(after.scheduled, true, "after a reset a failure schedules again");
  assert.equal(after.remaining, rounds - 1);
  assert.equal(after.looksRemaining, CATALOG_RESTART_MAX_LOOKS, "and the decline allowance is fresh too");
}

// 6. Defaults are the ones the proposal names (5s × 3), so a drifting constant is caught here.
{
  const { policy } = harness();
  assert.equal(policy.state.maxAttempts, 3);
}

// 7. A DECLINE (busy / bridge not ready) is not a failed restart: it draws on
//    its OWN allowance, keeps looking on the same cadence, and never consumes
//    the failure budget. Measured 2026-11-14 (full e2e run): three declines
//    landed inside one long busy stretch, the shared budget expired, and the
//    rewrite then waited for a transition that the same stretch guaranteed would
//    not come — the roster was lost for the test's whole 90s window.
{
  const { policy, queued, retried, exhausted, fire } = harness();
  const first = policy.noteDeferred("busy");
  assert.equal(first.scheduled, true, "a decline schedules the next look");
  assert.equal(queued.length, 1);
  // Repeated declines while one is queued must not pile timers up.
  policy.noteDeferred("busy");
  policy.noteDeferred("bridge not ready");
  assert.equal(queued.length, 1, "declines share one queued retry");
  fire();
  assert.equal(retried.length, 1, "the look actually happens");

  // Far more declines than the FAILURE budget: still looking, no exhaustion.
  for (let i = 0; i < CATALOG_RESTART_MAX_ATTEMPTS * 5; i++) {
    policy.noteDeferred("busy");
    if (policy.state.pending) fire();
  }
  assert.equal(policy.state.attempts, 0, "declines never charge the failure budget");
  assert.equal(exhausted.length, 0, "a long busy stretch is not a failure");
  assert.equal(policy.state.looks, CATALOG_RESTART_MAX_ATTEMPTS * 5 + 1);

  // The look allowance itself is bounded — a runtime that never idles stops.
  for (let i = policy.state.looks; i < policy.state.maxLooks; i++) {
    policy.noteDeferred("busy");
    if (policy.state.pending) fire();
  }
  policy.noteDeferred("busy");
  assert.equal(policy.state.looks, policy.state.maxLooks);
  assert.ok(exhausted.length >= 1, "exhaustion is reported with its reason");
  assert.equal(exhausted.at(-1).reason, "busy");
  assert.equal(policy.state.pending, false, "no timer after exhaustion");

  // A delivery after a decline episode still clears everything, and the failure
  // budget was available the whole time (a decline is not a failed restart).
  policy.reset();
  policy.noteDeferred("busy");
  policy.noteSuccess();
  assert.deepEqual(policy.state, {
    attempts: 0,
    looks: 0,
    pending: false,
    maxAttempts: CATALOG_RESTART_MAX_ATTEMPTS,
    maxLooks: CATALOG_RESTART_MAX_LOOKS,
  });
}

// 8. The two allowances are independent: a failed restart still stops at 3 even
//    with a fresh look allowance, and a decline storm does not eat the failures.
{
  const { policy, exhausted, fire } = harness();
  for (let i = 0; i < CATALOG_RESTART_MAX_LOOKS; i++) {
    policy.noteDeferred("bridge not ready");
    if (policy.state.pending) fire();
  }
  assert.equal(policy.state.attempts, 0);
  policy.reset();
  for (let i = 0; i < CATALOG_RESTART_MAX_ATTEMPTS; i++) {
    policy.noteFailure();
    if (policy.state.pending) fire();
  }
  assert.equal(policy.state.attempts, CATALOG_RESTART_MAX_ATTEMPTS, "failures keep their own small budget");
  assert.equal(exhausted.at(-1).reason, "restart failed");
}

console.log("catalog-restart-retry: 8/8 groups passed");
