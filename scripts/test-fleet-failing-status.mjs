// Unit tests — fleet failure visibility (fix-fleet-failure-visibility).
//
// The defect (fd-wire 2026-10-26 census, 178 turns / 74% failed): a post that
// failed twelve rounds in a row still read `on_duty`, the canvas stayed green
// and `statusCounts.normal` counted it. Unattended fleets stopped producing
// and nobody could see it.
//
// Pins:
//   - a streak at/above the threshold downgrades the status to `failing`
//   - below the threshold nothing changes (a working post is not alarmed)
//   - `missing` keeps precedence (losing the signal is worse than failing)
//   - interrupted rounds never count; one success clears the state
//   - the streak + its attribution (since / last kind) ride the evidence
//   - the threshold is configurable
//
// Run: node --test scripts/test-fleet-failing-status.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { deriveMemberStatus } = await import("../server/fleet-reconcile.js");

const _HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-26T12:00:00Z");

const member = (over = {}) => ({
  id: "m_1",
  fleetId: "f_1",
  title: "投稿岗",
  targetKind: "persona",
  targetId: "persona-a",
  cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  kpiSlots: [],
  ...over,
});
const fleet = { id: "f_1", state: "active" };
// A task that ran recently enough to read on_duty (daily cadence → 48h window).
const freshTask = { id: "j_1", lastRun: "2026-10-26T01:00:00Z", nextRun: "2026-10-27T01:00:00Z" };

const derive = (extra = {}, opts = {}) =>
  deriveMemberStatus({
    member: opts.member ?? member(),
    fleet,
    task: opts.task === undefined ? freshTask : opts.task,
    targetAlive: true,
    now: NOW,
    ...extra,
  });

test("a streak at the threshold downgrades the post to failing", () => {
  const d = derive({
    failureStreak: 3,
    failureSince: "2026-10-25T01:00:00Z",
    lastFailureKind: "runtime_not_ready",
  });
  assert.equal(d.status, "failing");
  assert.match(d.reason, /3 consecutive failed rounds/);
  assert.match(d.reason, /runtime_not_ready/);
  assert.equal(d.evidence.failureStreak, 3);
  assert.equal(d.evidence.failingSince, "2026-10-25T01:00:00Z");
  assert.equal(d.evidence.lastErrorKind, "runtime_not_ready");
});

test("a sub-threshold streak leaves the post on duty (working posts are not alarmed)", () => {
  for (const streak of [0, 1, 2]) {
    const d = derive({ failureStreak: streak, lastFailureKind: "timeout" });
    assert.equal(d.status, "on_duty", `streak ${streak} stays on duty`);
    assert.equal(d.evidence.failureStreak, streak, "the streak is still visible");
  }
});

test("one success clears the state — the caller simply reports a zero streak", () => {
  const d = derive({ failureStreak: 0, failureSince: null, lastFailureKind: null });
  assert.equal(d.status, "on_duty");
  assert.equal(d.evidence.failingSince, null);
  assert.equal(d.evidence.lastErrorKind, null);
});

test("missing keeps precedence over failing (no signal is worse than failing)", () => {
  // Beyond the 48h tolerance window AND a long streak.
  const d = derive(
    { failureStreak: 9, lastFailureKind: "runtime_not_ready" },
    { task: { id: "j_1", lastRun: "2026-10-20T01:00:00Z" } },
  );
  assert.equal(d.status, "missing");
  assert.equal(d.evidence.failureStreak, 9, "the streak stays readable alongside");
});

test("paused and passive posts are not downgraded by a streak", () => {
  const paused = derive({ failureStreak: 5 }, { member: member({ cadence: { cron: "0 9 * * *", enabled: false } }) });
  assert.equal(paused.status, "paused");
  const passive = derive({ failureStreak: 5 }, { member: member({ cadence: null }) });
  assert.equal(passive.status, "passive");
});

test("the threshold is configurable via PLATFORM_FLEET_FAILING_STREAK", () => {
  const prev = process.env.PLATFORM_FLEET_FAILING_STREAK;
  try {
    process.env.PLATFORM_FLEET_FAILING_STREAK = "2";
    assert.equal(derive({ failureStreak: 2 }).status, "failing");
    process.env.PLATFORM_FLEET_FAILING_STREAK = "5";
    assert.equal(derive({ failureStreak: 3 }).status, "on_duty");
    assert.equal(derive({ failureStreak: 5 }).status, "failing");
  } finally {
    if (prev === undefined) delete process.env.PLATFORM_FLEET_FAILING_STREAK;
    else process.env.PLATFORM_FLEET_FAILING_STREAK = prev;
  }
});

test("defaults are honest when the caller passes no streak (pre-change shape)", () => {
  const d = deriveMemberStatus({
    member: member(), fleet, task: freshTask, targetAlive: true, now: NOW,
  });
  assert.equal(d.status, "on_duty");
  assert.equal(d.evidence.failureStreak, 0);
  assert.equal(d.evidence.failingSince, null);
  assert.equal(d.evidence.lastErrorKind, null);
});
