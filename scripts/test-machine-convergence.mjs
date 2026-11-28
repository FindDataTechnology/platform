// Unit tests for the convergence indicator derivation (openspec:
// add-machine-lifecycle-console, task 3.3). Framework-free, plain node.

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveConvergence } from "../web/src/lib/machine-convergence.ts";

const NOW = 1_700_000_000_000;
const FRESH = NOW - 1_000; // 1s old — well inside the staleness window
const STALE = NOW - 10 * 60_000; // 10min old — past the 5min window

const base = { desiredVersion: 7, silence: "online", now: NOW };

test("four primary states derive from seen vs desired plus presence", () => {
  // synced: machine consumed the current version, online
  assert.deepEqual(deriveConvergence({ ...base, detail: { at: FRESH, merge: { desiredVersionSeen: 7 } } }), { state: "synced", seenVersion: 7 });
  // a HIGHER seen (machine saw a newer edit mid-poll) still reads synced
  assert.deepEqual(deriveConvergence({ ...base, detail: { at: FRESH, merge: { desiredVersionSeen: 8 } } }), { state: "synced", seenVersion: 8 });
  // converging: behind but online — the next beat (≤60s) will fetch it
  assert.deepEqual(deriveConvergence({ ...base, detail: { at: FRESH, merge: { desiredVersionSeen: 6 } } }), { state: "converging", seenVersion: 6 });
  // awaiting: behind and silent — expectation is durable, applies on return
  assert.deepEqual(deriveConvergence({ ...base, silence: "silent", detail: { at: FRESH, merge: { desiredVersionSeen: 6 } } }), { state: "awaiting", seenVersion: 6 });
  assert.deepEqual(deriveConvergence({ ...base, silence: "never_reported", detail: { at: FRESH, merge: { desiredVersionSeen: 6 } } }), { state: "awaiting", seenVersion: 6 });
  // diverged: versions equal but an enabled expectation is missing live
  assert.deepEqual(deriveConvergence({ ...base, divergenceStreak: 2, detail: { at: FRESH, merge: { desiredVersionSeen: 7 } } }), { state: "diverged", seenVersion: 7 });
});

test("two degradations: no detail and stale snapshot never fake a verdict", () => {
  // no detail at all
  assert.deepEqual(deriveConvergence({ ...base, detail: null }), { state: "unknown", seenVersion: null });
  // detail present but the machine never reported merge info
  assert.deepEqual(deriveConvergence({ ...base, detail: { at: FRESH } }), { state: "unknown", seenVersion: null });
  // stale snapshot: unknown even though the numbers look aligned
  assert.deepEqual(deriveConvergence({ ...base, detail: { at: STALE, merge: { desiredVersionSeen: 7 } } }), { state: "stale", seenVersion: 7 });
  assert.deepEqual(deriveConvergence({ ...base, silence: "silent", detail: { at: STALE, merge: { desiredVersionSeen: 6 } } }), { state: "stale", seenVersion: 6 });
});

test("zero desired version with an aligned machine reads synced, divergence wins when open", () => {
  // nothing authored yet: seen 0 >= desired 0 → synced (nothing to converge)
  assert.deepEqual(deriveConvergence({ ...base, desiredVersion: 0, detail: { at: FRESH, merge: { desiredVersionSeen: 0 } } }), { state: "synced", seenVersion: 0 });
  // divergence episode open outranks synced even at version 0
  assert.deepEqual(deriveConvergence({ ...base, desiredVersion: 0, divergenceStreak: 1, detail: { at: FRESH, merge: { desiredVersionSeen: 0 } } }), { state: "diverged", seenVersion: 0 });
});
