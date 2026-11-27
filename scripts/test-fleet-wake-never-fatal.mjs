// A deferred fleet-event wake must never kill the process.
// Run: node --test scripts/test-fleet-wake-never-fatal.mjs
//
// 2026-11-19: a group message reached the Zhiyu room, and four seconds later the
// cell exited with code=1 — three times running. The user saw "no reply" and
// nothing anywhere said why. Chain:
//
//   server.js wired triggerFleetEventWake({db, engine, roster})   ← no resolveTarget
//   → coalescing window buffered it (returned [], no throw)
//   → the flush ran in a setTimeout, OUTSIDE every caller's try/catch
//   → deliverFleetEventWake's own dependency guard threw
//   → process exited
//
// The guard is right (a forgotten injection must not silently drop the wake
// lane). What was wrong is that a DEFERRED optimisation could be fatal.

import test from "node:test";
import assert from "node:assert/strict";

import { triggerFleetEventWake } from "../server/fleet-event-wake.js";

const depsMissingTarget = {
  db: { listFleets: () => [{ id: "f1", state: "active", orchestration: { edges: [] } }] },
  engine: null,
  // resolveTarget deliberately absent — the production wiring's bug.
};

test("a deferred wake with a missing dependency logs instead of crashing", async () => {
  process.env.EVENT_WAKE_COALESCE_MS = "30";
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    // Buffered (no throw here) — the failure lands in the timer.
    assert.deepEqual(triggerFleetEventWake(depsMissingTarget, "bot1", { chatKey: "c1", text: "hi" }), []);
    await new Promise((r) => setTimeout(r, 1200));
    // If the deferred throw escaped, this test process would have died and the
    // assertion below would never run — which is itself the proof.
    assert.ok(
      errors.some((e) => e.includes("deferred event wake failed")),
      "the failure is reported, not swallowed",
    );
  } finally {
    console.error = origError;
    delete process.env.EVENT_WAKE_COALESCE_MS;
  }
});

test("the immediate path (coalescing off) still throws — the guard is intact", () => {
  // A caller that CAN handle it must still be told. Only the deferred path is
  // made non-fatal; the dependency guard itself is unchanged.
  process.env.EVENT_WAKE_COALESCE_MS = "0";
  try {
    assert.throws(
      () => triggerFleetEventWake(depsMissingTarget, "bot1", { chatKey: "c1", text: "hi" }),
      /resolveTarget/,
    );
  } finally {
    delete process.env.EVENT_WAKE_COALESCE_MS;
  }
});
