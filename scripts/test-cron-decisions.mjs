// Unit tests — cron decision pure functions (harden-cell-execution-reliability
// 3.1: "cron-runner decisions are testable pure functions").
//
// Pins the decision contracts that used to live inline in server/cron-runner.js
// runPersonaTurn and cron.js's downtime accounting, now extracted into
// server/cron-decisions.js:
//   - the one-hop fast-failure retry gate (fix-fleet-turn-attribution D5):
//     upstream-class failure only, never interrupted, only while the fast
//     window is open and the degrade chain still has an untried hop
//   - the single-tier budget degrade gate (add-model-surface-budget-gate):
//     success + over-cap tokens under the same window/hop conditions
//   - the fast-failure window resolution (PLATFORM_LLM_RETRY_FAST_MS)
//   - the downtime catch-up tolerance window (2 × period, 6h floor,
//     PLATFORM_CRON_CATCHUP=0 kill switch, inclusive boundary) — both the pure
//     verdict and its live wrapper cron.js withinToleranceWindow (同口径)
//   - the missed-occurrence counting core (strict gap, capped walk)
//
// Run: node --test scripts/test-cron-decisions.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  RETRY_FAST_DEFAULT_MS,
  retryFastWindowMs,
  fastWindowWithUntriedHop,
  shouldRetryFastFailure,
  shouldRetryZeroOutput,
  producedNothing,
  shouldDegradeOverBudget,
  CATCH_UP_FLOOR_MS,
  catchUpWindowMs,
  withinCatchUpWindow,
  MAX_MISSED_PER_LOAD,
  countMissedBetween,
} = await import("../server/cron-decisions.js");
const { withinToleranceWindow } = await import("../cron.js");

const HOUR = 60 * 60 * 1000;

// ── Fast-failure window resolution ───────────────────────────────────────────

test("retryFastWindowMs: default 60s when unset, garbage, zero or negative; positive override wins", () => {
  assert.equal(RETRY_FAST_DEFAULT_MS, 60_000);
  assert.equal(retryFastWindowMs({}), 60_000);
  assert.equal(retryFastWindowMs({ PLATFORM_LLM_RETRY_FAST_MS: "" }), 60_000);
  assert.equal(retryFastWindowMs({ PLATFORM_LLM_RETRY_FAST_MS: "abc" }), 60_000);
  assert.equal(retryFastWindowMs({ PLATFORM_LLM_RETRY_FAST_MS: "0" }), 60_000);
  assert.equal(retryFastWindowMs({ PLATFORM_LLM_RETRY_FAST_MS: "-5" }), 60_000);
  assert.equal(retryFastWindowMs({ PLATFORM_LLM_RETRY_FAST_MS: "45000" }), 45_000);
  assert.equal(retryFastWindowMs({ PLATFORM_LLM_RETRY_FAST_MS: "300000" }), 300_000);
});

// ── One-hop fast-failure retry gate (runPersonaTurn) ─────────────────────────

test("shouldRetryFastFailure: a fast upstream failure with an untried hop retries ONCE", () => {
  const base = {
    result: { ok: false, interrupted: false },
    errorKind: "model_upstream",
    elapsedMs: 1_000,
    retryFastMs: 60_000,
    candidates: ["model-a", "model-b"],
    landedIndex: 0,
  };
  assert.equal(shouldRetryFastFailure(base), true);
});

test("shouldRetryFastFailure: the fast window boundary is exclusive (elapsed == window is too late)", () => {
  const base = {
    result: { ok: false, interrupted: false },
    errorKind: "model_upstream",
    retryFastMs: 60_000,
    candidates: ["model-a", "model-b"],
    landedIndex: 0,
  };
  assert.equal(shouldRetryFastFailure({ ...base, elapsedMs: 59_999 }), true);
  assert.equal(shouldRetryFastFailure({ ...base, elapsedMs: 60_000 }), false);
  assert.equal(shouldRetryFastFailure({ ...base, elapsedMs: 60_001 }), false);
});

test("shouldRetryFastFailure: interruption, non-upstream kinds and an exhausted chain never retry", () => {
  const base = {
    result: { ok: false, interrupted: false },
    errorKind: "model_upstream",
    elapsedMs: 1_000,
    retryFastMs: 60_000,
    candidates: ["model-a", "model-b"],
    landedIndex: 0,
  };
  // An abort (bridge restart mid-turn) is not a failure to retry — the engine
  // marks it re-runnable instead.
  assert.equal(shouldRetryFastFailure({ ...base, result: { ok: false, interrupted: true } }), false);
  // Timeouts and tool failures are the work's own shape — another model would
  // hit them too; only the upstream class degrades.
  for (const kind of ["timeout", "tool_permission", "business_refused", "runtime_not_ready", "other"]) {
    assert.equal(shouldRetryFastFailure({ ...base, errorKind: kind }), false, kind);
  }
  // The chain must still have an untried hop.
  assert.equal(shouldRetryFastFailure({ ...base, landedIndex: 1 }), false, "last hop already landed");
  assert.equal(shouldRetryFastFailure({ ...base, candidates: [] }), false);
  assert.equal(shouldRetryFastFailure({ ...base, candidates: "model-a,model-b" }), false);
  assert.equal(shouldRetryFastFailure({ ...base, candidates: null }), false);
  // A successful attempt and a missing outcome never retry.
  assert.equal(shouldRetryFastFailure({ ...base, result: { ok: true } }), false);
  assert.equal(shouldRetryFastFailure({ ...base, result: null }), false);
});

// ── Single-tier budget degrade gate (runPersonaTurn) ─────────────────────────

test("shouldDegradeOverBudget: a successful turn over the single cap degrades ONE hop under the same rules", () => {
  const base = {
    result: { ok: true, interrupted: false },
    tokens: 9_000,
    singleCap: 8_192,
    elapsedMs: 1_000,
    retryFastMs: 60_000,
    candidates: ["model-a", "model-b"],
    landedIndex: 0,
  };
  assert.equal(shouldDegradeOverBudget(base), true);
  // Exactly at the cap is not over it; below it never degrades.
  assert.equal(shouldDegradeOverBudget({ ...base, tokens: 8_192 }), false);
  assert.equal(shouldDegradeOverBudget({ ...base, tokens: 8_191 }), false);
  // Honest absence of usage is not an over-cap event.
  assert.equal(shouldDegradeOverBudget({ ...base, tokens: null }), false);
  // No cap configured → Infinity → never over.
  assert.equal(shouldDegradeOverBudget({ ...base, singleCap: undefined }), false);
  // Same fast-window exclusivity and untried-hop requirement.
  assert.equal(shouldDegradeOverBudget({ ...base, elapsedMs: 60_000 }), false);
  assert.equal(shouldDegradeOverBudget({ ...base, landedIndex: 1 }), false);
  // A failed turn belongs to the failure gate, not the budget gate; an
  // interrupted turn belongs to neither.
  assert.equal(shouldDegradeOverBudget({ ...base, result: { ok: false, interrupted: false } }), false);
  assert.equal(shouldDegradeOverBudget({ ...base, result: { ok: true, interrupted: true } }), false);
});

test("fastWindowWithUntriedHop: the shared tail both one-hop gates ride", () => {
  assert.equal(
    fastWindowWithUntriedHop({ elapsedMs: 10, retryFastMs: 60_000, candidates: ["a"], landedIndex: 0 }),
    false,
    "no untried hop",
  );
  assert.equal(
    fastWindowWithUntriedHop({ elapsedMs: 10, retryFastMs: 60_000, candidates: ["a", "b"], landedIndex: 0 }),
    true,
  );
  assert.equal(
    fastWindowWithUntriedHop({ elapsedMs: 60_000, retryFastMs: 60_000, candidates: ["a", "b"], landedIndex: 0 }),
    false,
    "window boundary is exclusive",
  );
  assert.equal(
    fastWindowWithUntriedHop({ elapsedMs: 10, retryFastMs: 60_000, candidates: null, landedIndex: 0 }),
    false,
  );
});

// ── Downtime catch-up tolerance window ───────────────────────────────────────

test("catchUpWindowMs: 2 × period with the 6h floor; a non-finite period falls back to the floor", () => {
  assert.equal(CATCH_UP_FLOOR_MS, 6 * HOUR);
  assert.equal(catchUpWindowMs(24 * HOUR), 48 * HOUR, "daily: 2 × period");
  assert.equal(catchUpWindowMs(3 * HOUR), 6 * HOUR, "exactly at the floor: 2×period == floor");
  assert.equal(catchUpWindowMs(2 * HOUR), 6 * HOUR, "short period: the floor wins");
  assert.equal(catchUpWindowMs(1 * HOUR), 6 * HOUR);
  assert.equal(catchUpWindowMs(7 * 24 * HOUR), 14 * 24 * HOUR, "weekly: 2 × period");
  assert.equal(catchUpWindowMs(0), 6 * HOUR);
  assert.equal(catchUpWindowMs(-HOUR), 6 * HOUR);
  assert.equal(catchUpWindowMs(Number.NaN), 6 * HOUR);
});

test("withinCatchUpWindow: kill switch, unparseable-rule degrade-open, never-ran, inclusive boundary", () => {
  const inside = { killSwitch: false, windowMs: 48 * HOUR, lastRunMs: 0, nowMs: 47 * HOUR };
  assert.equal(withinCatchUpWindow(inside), true);
  // The kill switch wins before anything else — even a broken rule or a
  // fresh task.
  assert.equal(withinCatchUpWindow({ ...inside, killSwitch: true }), false);
  assert.equal(withinCatchUpWindow({ killSwitch: true, windowMs: null, lastRunMs: null, nowMs: 0 }), false);
  // windowMs null encodes "the rule failed to parse here": degrade OPEN —
  // never suppress a make-up on a rule the scheduler accepted.
  assert.equal(withinCatchUpWindow({ killSwitch: false, windowMs: null, lastRunMs: 0, nowMs: 10 * 24 * HOUR }), true);
  // A task that never ran has no missed round to make up.
  assert.equal(withinCatchUpWindow({ killSwitch: false, windowMs: 48 * HOUR, lastRunMs: null, nowMs: 0 }), false);
  assert.equal(withinCatchUpWindow({ killSwitch: false, windowMs: 48 * HOUR, lastRunMs: Number.NaN, nowMs: 0 }), false);
  // The boundary is inclusive: a gap of exactly the window is still inside it.
  assert.equal(withinCatchUpWindow({ killSwitch: false, windowMs: 48 * HOUR, lastRunMs: 0, nowMs: 48 * HOUR }), true);
  assert.equal(withinCatchUpWindow({ killSwitch: false, windowMs: 48 * HOUR, lastRunMs: 0, nowMs: 48 * HOUR + 1 }), false);
});

// ── The live wrapper (cron.js withinToleranceWindow) rides the same verdict ──

test("cron.js withinToleranceWindow: daily cadence — inside, exactly 2×period, past it, never-ran, kill switch", () => {
  // Daily 09:00 Asia/Shanghai (no DST in that zone): period 24h → window 48h.
  const daily = { id: "j", cron: "0 9 * * *", tz: "Asia/Shanghai", lastRun: "2026-11-10T01:00:00Z" };
  // 窗内正常补: the restart lands 2h after the missed trigger — well inside.
  assert.equal(withinToleranceWindow(daily, Date.parse("2026-11-10T03:00:00Z")), true);
  // 恰 2×周期: a gap of exactly 48h is still inside (inclusive boundary).
  assert.equal(withinToleranceWindow(daily, Date.parse("2026-11-12T01:00:00Z")), true);
  // 超窗: one millisecond past 2 × period — the gap is past saving.
  assert.equal(withinToleranceWindow(daily, Date.parse("2026-11-12T01:00:00Z") + 1), false);
  // A task that never ran has no missed round to make up.
  assert.equal(withinToleranceWindow({ ...daily, lastRun: null }, Date.parse("2026-11-10T03:00:00Z")), false);
  // Kill switch (PLATFORM_CRON_CATCHUP=0) suppresses the make-up; turning it
  // back off restores normal catch-up.
  process.env.PLATFORM_CRON_CATCHUP = "0";
  try {
    assert.equal(withinToleranceWindow(daily, Date.parse("2026-11-10T03:00:00Z")), false);
  } finally {
    delete process.env.PLATFORM_CRON_CATCHUP;
  }
  assert.equal(withinToleranceWindow(daily, Date.parse("2026-11-10T03:00:00Z")), true);
});

test("cron.js withinToleranceWindow: hourly cadence rides the 6h floor (boundary inclusive)", () => {
  // Hourly cadence: 2 × 1h period < 6h floor → the window IS the floor.
  const hourly = { id: "j2", cron: "0 * * * *", tz: null, lastRun: "2026-11-10T00:00:00Z" };
  assert.equal(withinToleranceWindow(hourly, Date.parse("2026-11-10T03:00:00Z")), true);
  // 6h 地板 boundary: exactly 6h is inside; one millisecond more is out.
  assert.equal(withinToleranceWindow(hourly, Date.parse("2026-11-10T06:00:00Z")), true);
  assert.equal(withinToleranceWindow(hourly, Date.parse("2026-11-10T06:00:00Z") + 1), false);
});

// ── Missed-occurrence counting core ──────────────────────────────────────────

test("countMissedBetween: counts occurrences strictly after lastRun, capped at MAX_MISSED_PER_LOAD", () => {
  assert.equal(MAX_MISSED_PER_LOAD, 100);
  // prev() walks DESCENDING (most recent first) — mimic a cron-parser iterator.
  const iterOf = (...times) => {
    let i = 0;
    return { prev: () => (i < times.length ? { toDate: () => new Date(times[i++]) } : null) };
  };
  const T0 = Date.parse("2026-11-10T09:00:00Z");
  // Three occurrences strictly after lastRun; the walk stops at the first one
  // at-or-before it.
  const iter = iterOf(T0 + 3 * HOUR, T0 + 2 * HOUR, T0 + HOUR, T0, T0 - HOUR);
  assert.equal(countMissedBetween(iter, T0), 3);
  // The boundary is strict: an occurrence exactly at lastRun was the last
  // delivered fire, not a missed one.
  assert.equal(countMissedBetween(iterOf(T0), T0), 0);
  assert.equal(countMissedBetween(iterOf(), T0), 0, "no occurrences at all");
  // The cap stops the walk (a task dead for years cannot spin the parser).
  const many = Array.from({ length: 150 }, (_, i) => T0 + (150 - i) * 60_000);
  assert.equal(countMissedBetween(iterOf(...many), T0), 100);
});

// ── Zero-output retry gate (2026-11-11) ─────────────────────────────────────

test("producedNothing: text / tool result / output tokens each count as something", () => {
  assert.equal(producedNothing({ ok: false }), true);
  assert.equal(producedNothing({ ok: false, text: "  " }), true);
  assert.equal(producedNothing({ ok: false, toolBlocks: [] }), true);
  assert.equal(producedNothing({ ok: false, text: "有话说" }), false);
  assert.equal(producedNothing({ ok: false, toolBlocks: [{ name: "report_status" }] }), false);
  assert.equal(producedNothing({ ok: false, usage: { output: 12 } }), false);
  assert.equal(producedNothing(null), false, "没有结果不是「零产出」，是不知道");
});

test("shouldRetryZeroOutput: ignores the fast window — a slot-burning loss is worth one retry", () => {
  // 现场依据：24h 内 54 次上游 5xx，42 次跑了 1 分钟以上，快速窗口物理上不可能命中；
  // 而这些长回合恰恰是损失最大的那一批。
  const slowTotalLoss = {
    result: { ok: false, interrupted: false },
    errorKind: "model_upstream",
    candidates: ["model-a", "model-b"],
    landedIndex: 0,
  };
  assert.equal(shouldRetryZeroOutput(slowTotalLoss), true);

  // 产出过东西就不重试：那是活干了一半，换模型会把半程作废。
  assert.equal(shouldRetryZeroOutput({ ...slowTotalLoss, result: { ok: false, text: "半程结论" } }), false);
  // 非上游、被中断、链已到底，一律不重试。
  assert.equal(shouldRetryZeroOutput({ ...slowTotalLoss, errorKind: "timeout" }), false);
  assert.equal(shouldRetryZeroOutput({ ...slowTotalLoss, result: { ok: false, interrupted: true } }), false);
  assert.equal(shouldRetryZeroOutput({ ...slowTotalLoss, landedIndex: 1 }), false);
  assert.equal(shouldRetryZeroOutput({ ...slowTotalLoss, candidates: null }), false);
});
