#!/usr/bin/env node
// ── Trial bounded-fire tests (fix-trial-fire-timeout) ────────────────────────
//
// Pins: a hung cron fire must not hold the trial lock or outlive the evidence
// window — fireJobBounded races the window, records the timeout honestly in
// the fired row, and lets the trial proceed (the existing `!f.error` turn
// filter reads it). A fast fire keeps its original shape byte-for-byte.
//
//   node --test scripts/test-trial-fire-timeout.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { fireJobBounded, fireTimeoutMs, FIRE_TIMEOUT_DEFAULT_MS } from "../server/blueprint-trial.js";

const JOB = { id: "job_1", sourceTag: { fleetId: "fleet_x", memberId: "m_1" } };

test("a hung fire returns within the window with an honest error row", async () => {
  const never = { runJobNow: () => new Promise(() => {}) };
  const t0 = Date.now();
  const row = await fireJobBounded(never, JOB, 120);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `bounded: returned in ${elapsed}ms`);
  assert.equal(row.jobId, "job_1");
  assert.equal(row.memberId, "m_1");
  assert.equal(row.error, "fire timeout");
});

test("a fast fire keeps the original shape (no error field)", async () => {
  const fast = { runJobNow: async () => ({}) };
  const row = await fireJobBounded(fast, JOB, 5000);
  assert.deepEqual(row, { jobId: "job_1", memberId: "m_1", at: row.at });
  assert.equal(row.error, undefined);
});

test("a rejecting fire records the failure message (existing semantics)", async () => {
  const boom = { runJobNow: async () => { throw new Error("cron queue full"); } };
  const row = await fireJobBounded(boom, JOB, 5000);
  assert.equal(row.error, "cron queue full");
});

test("the window default is 90s and env-overridable", () => {
  assert.equal(fireTimeoutMs({}), FIRE_TIMEOUT_DEFAULT_MS);
  assert.equal(fireTimeoutMs({ BLUEPRINT_FIRE_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(fireTimeoutMs({ BLUEPRINT_FIRE_TIMEOUT_MS: "0" }), FIRE_TIMEOUT_DEFAULT_MS, "non-positive falls back");
  assert.equal(fireTimeoutMs({ BLUEPRINT_FIRE_TIMEOUT_MS: "bogus" }), FIRE_TIMEOUT_DEFAULT_MS);
});
