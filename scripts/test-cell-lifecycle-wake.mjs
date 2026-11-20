// Unit tests — duty-ring wake coverage for every schedule form
// (fix-audit-code-gaps: cronJobsDue used to recognize cron rows only, so a
// suspended on_demand cell holding an interval task or a pending one-shot was
// never woken and the obligation silently died).
//
// Pins:
//   - interval recurring rows are judged by the engine's anchor-grid math
//     (anchor + k × step, cron.js nextIntervalOccurrence 口径) — due when an
//     occurrence has landed past lastRun (or past the anchor when never run)
//   - a pending one-shot (never fired, `when` still ahead) wakes the cell —
//     the engine expires a one-shot that finds its time passed at boot, so the
//     cell must be up BEFORE the moment
//   - cron rows keep their exact pre-change due semantics (no regression)
//   - paused rows and rows retired at their maxRuns cap never wake
//   - the whole predicate is total: junk rows never throw
//   - end to end: the duty ring ticks a suspended on_demand cell awake for an
//     interval obligation and a future one-shot (scan-only, from jobs.json)
//
// Run: node --test scripts/test-cell-lifecycle-wake.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cronJobsDue } = await import("../lib/cell-lifecycle.js");
const { createDutyRing } = await import("../gateway/duty-ring.js");
const { newRegistryRow } = await import("../lib/cell-registry.js");

const NOW = Date.parse("2026-11-06T08:02:00Z"); // deliberately off the */5 grid
const MIN = 60_000;

const intervalJob = (over = {}) => ({
  id: "j-int",
  trigger: "schedule",
  type: "recurring",
  interval: { number: 30, unit: "minute" },
  anchor: new Date(NOW - 90 * MIN).toISOString(), // grid: −60, −30, ±0
  prompt: "patrol",
  preset: null,
  targetType: "persona",
  tz: null,
  status: "scheduled",
  paused: false,
  createdAt: new Date(NOW - 90 * MIN).toISOString(),
  lastRun: null,
  nextRun: null,
  missed: 0,
  history: [],
  ...over,
});

const onceJob = (over = {}) => ({
  id: "j-once",
  trigger: "schedule",
  type: "once",
  when: new Date(NOW + 10 * MIN).toISOString(),
  prompt: "deliver",
  preset: null,
  targetType: "persona",
  tz: null,
  status: "scheduled",
  paused: false,
  createdAt: new Date(NOW - 5 * MIN).toISOString(),
  lastRun: null,
  nextRun: null,
  missed: 0,
  history: [],
  ...over,
});

const cronJob = (over = {}) => ({
  id: "j-cron",
  trigger: "schedule",
  type: "recurring",
  cron: "*/5 * * * *",
  tz: null,
  paused: false,
  lastRun: new Date(NOW - 10 * MIN).toISOString(), // next grid point −5m: due
  createdAt: null,
  ...over,
});

// ── interval recurring ───────────────────────────────────────────────────────

test("interval: an occurrence past the anchor (never run) is due", () => {
  // anchor −90m, step 30m → occurrences at −60m and −30m have landed.
  assert.equal(cronJobsDue([intervalJob()], NOW), true);
});

test("interval: no occurrence since the anchor stays asleep", () => {
  // anchor −10m, step 30m → first occurrence +20m: nothing due yet.
  assert.equal(cronJobsDue([intervalJob({ anchor: new Date(NOW - 10 * MIN).toISOString(), createdAt: new Date(NOW - 10 * MIN).toISOString() })], NOW), false);
});

test("interval: judged from lastRun — a served occurrence does not re-wake, a landed one does", () => {
  // anchor −40m, step 30m → grid −10m, +20m. lastRun −5m served the −10m beat;
  // the next one is in the future → not due.
  const served = intervalJob({
    anchor: new Date(NOW - 40 * MIN).toISOString(),
    createdAt: new Date(NOW - 40 * MIN).toISOString(),
    lastRun: new Date(NOW - 5 * MIN).toISOString(),
  });
  assert.equal(cronJobsDue([served], NOW), false);
  // lastRun −15m (before the −10m beat): that beat is unserved → due.
  const pending = intervalJob({
    anchor: new Date(NOW - 40 * MIN).toISOString(),
    createdAt: new Date(NOW - 40 * MIN).toISOString(),
    lastRun: new Date(NOW - 15 * MIN).toISOString(),
  });
  assert.equal(cronJobsDue([pending], NOW), true);
});

test("interval: all four units compute on the cron-module step table", () => {
  // minute/hour/day/week — every unit must produce a finite next occurrence.
  for (const [unit, ms] of [["minute", MIN], ["hour", 60 * MIN], ["day", 1440 * MIN], ["week", 10080 * MIN]]) {
    const due = cronJobsDue([intervalJob({ interval: { number: 1, unit }, anchor: new Date(NOW - 2 * ms).toISOString(), createdAt: new Date(NOW - 2 * ms).toISOString() })], NOW);
    assert.equal(due, true, `unit ${unit} due two periods after the anchor`);
    const asleep = cronJobsDue([intervalJob({ interval: { number: 1, unit }, anchor: new Date(NOW - ms / 2).toISOString(), createdAt: new Date(NOW - ms / 2).toISOString() })], NOW);
    assert.equal(asleep, false, `unit ${unit} asleep half a period after the anchor`);
  }
});

test("interval: paused and cap-retired rows never wake", () => {
  assert.equal(cronJobsDue([intervalJob({ paused: true })], NOW), false);
  assert.equal(cronJobsDue([intervalJob({ maxRuns: 3, runs: 3 })], NOW), false, "跑满即 completed — the engine stopped firing it");
  assert.equal(cronJobsDue([intervalJob({ maxRuns: 3, runs: 2 })], NOW), true, "under the cap it is still live");
});

test("interval: a malformed rule degrades to not-due, never throws", () => {
  assert.equal(cronJobsDue([intervalJob({ interval: { number: 2, unit: "year" } })], NOW), false);
  assert.equal(cronJobsDue([intervalJob({ interval: { number: 0, unit: "day" } })], NOW), false);
  assert.equal(cronJobsDue([intervalJob({ anchor: "not-a-date" })], NOW), false);
});

// ── one-shot ─────────────────────────────────────────────────────────────────

test("one-shot: a future untriggered target wakes the cell", () => {
  assert.equal(cronJobsDue([onceJob()], NOW), true, "the cell must be up BEFORE the moment");
});

test("one-shot: fired, past, expired, and paused targets never wake", () => {
  assert.equal(cronJobsDue([onceJob({ lastRun: new Date(NOW - MIN).toISOString() })], NOW), false, "already served");
  // A past-due untriggered row is dead by design: the engine expires it at
  // boot (stays in history) — waking cannot save it.
  assert.equal(cronJobsDue([onceJob({ when: new Date(NOW - 30 * MIN).toISOString() })], NOW), false);
  assert.equal(cronJobsDue([onceJob({ when: new Date(NOW - 30 * MIN).toISOString(), status: "expired" })], NOW), false);
  assert.equal(cronJobsDue([onceJob({ paused: true })], NOW), false);
});

// ── cron regression + totality ───────────────────────────────────────────────

test("cron: pre-change due semantics are unchanged", () => {
  assert.equal(cronJobsDue([cronJob()], NOW), true, "occurrence −7m past lastRun −10m");
  assert.equal(cronJobsDue([cronJob({ lastRun: new Date(NOW - 2 * MIN).toISOString() })], NOW), false, "next grid point +3m: nothing due");
  assert.equal(cronJobsDue([cronJob({ paused: true })], NOW), false);
  assert.equal(cronJobsDue([cronJob({ maxRuns: 3, runs: 3 })], NOW), false, "cap-retired cron rows stop waking too");
});

test("the predicate is total: junk rows never throw", () => {
  assert.equal(cronJobsDue([null, {}, { type: "recurring" }, { type: "once" }, intervalJob({ type: "manual" })], NOW), false);
});

// ── end to end: the ring wakes for the new forms ─────────────────────────────

function ringSetup(jobs) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wake-ring-"));
  const cellId = "c1a2b3c4d5e6f701";
  const dir = path.join(dataRoot, cellId, "data", "cron-store");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify(jobs));
  const row = {
    ...newRegistryRow({ cellId, ownerEmail: "u@x.y", policy: "on_demand", now: NOW - 60 * MIN }),
    state: "suspended",
  };
  const wakes = [];
  const ring = createDutyRing({
    registryDb: { all: () => [row], put: () => {} },
    dataRoot,
    ensure: (u) => { wakes.push(u.email); return Promise.resolve(); },
    tickMs: 60 * MIN,
    now: () => NOW,
    log: { log: () => {}, warn: () => {} },
  });
  return { ring, wakes };
}

test("duty ring: a suspended cell with a due interval task gets woken", async () => {
  const { ring, wakes } = ringSetup([intervalJob()]);
  await ring.tick();
  assert.deepEqual(wakes, ["u@x.y"]);
});

test("duty ring: a suspended cell with a future one-shot gets woken", async () => {
  const { ring, wakes } = ringSetup([onceJob()]);
  await ring.tick();
  assert.deepEqual(wakes, ["u@x.y"]);
});

test("duty ring: a cell holding only a paused interval task stays asleep", async () => {
  const { ring, wakes } = ringSetup([intervalJob({ paused: true })]);
  await ring.tick();
  assert.deepEqual(wakes, []);
});
