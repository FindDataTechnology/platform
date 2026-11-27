// Scheduled-task list scope (fix-cron-list-scope).
//
// One production cell held 816 tasks — 658 of them fleet materializations (one
// cadence per post). `cron_list` shipped every row: 112KB per call, the largest
// single tool result on the fleet, four fifths of it noise for the question the
// tool answers ("what are MY scheduled tasks").
//
// This pins the scope/page contract, and — the part that matters — that the
// header always accounts for what is not shown.
//
// Run: node --test scripts/test-cron-list-view.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { shapeCronList, CRON_LIST_LIMIT, CRON_LIST_MAX, CRON_SCOPES, isFleetTask } = await import("../server/cron-list-view.js");

const task = (n, { fleet = false } = {}) => ({
  id: `job_${n}`,
  status: "active",
  type: "recurring",
  cron: "0 9 * * *",
  tz: null,
  prompt: `p${n}`,
  ...(fleet ? { sourceTag: { fleetId: `f${n % 7}`, memberId: `m${n}` } } : {}),
});
const mixed = () => [...Array.from({ length: 116 }, (_, i) => task(i)), ...Array.from({ length: 658 }, (_, i) => task(1000 + i, { fleet: true }))];

test("默认只看操作者自己的任务，并报出被排除的舰队量", () => {
  const v = shapeCronList(mixed());
  assert.equal(v.total, 116, "operator tasks only");
  assert.equal(v.fleetTotal, 658);
  assert.equal(v.allTotal, 774);
  assert.equal(v.jobs.length, CRON_LIST_LIMIT, "paged");
  assert.equal(v.truncated, true);
  assert.match(v.header, /scope=user/);
  assert.match(v.header, /658 fleet-materialized/, "the excluded mass is stated, never hidden");
  assert.match(v.header, /next offset 30/);
  assert.ok(v.jobs.every((j) => !isFleetTask(j)));
});

test("scope=fleet 只看舰队物化；scope=all 给审计", () => {
  const fleet = shapeCronList(mixed(), { scope: "fleet" });
  assert.equal(fleet.total, 658);
  assert.ok(fleet.jobs.every(isFleetTask));
  const all = shapeCronList(mixed(), { scope: "all" });
  assert.equal(all.total, 774);
  assert.match(all.header, /116 operator, 658 fleet/);
  // An unknown scope falls back to the safe default rather than dumping all.
  assert.equal(shapeCronList(mixed(), { scope: "bogus" }).total, 116);
});

test("分页可走到底、上限封顶、越界页如实为空", () => {
  const v = shapeCronList(mixed(), { limit: 50 });
  assert.equal(v.jobs.length, 50);
  assert.match(v.header, /showing 1-50 of 116/);
  const last = shapeCronList(mixed(), { limit: 50, offset: 100 });
  assert.equal(last.jobs.length, 16);
  assert.equal(last.truncated, false);
  const over = shapeCronList(mixed(), { limit: 9999 });
  assert.equal(over.limit, CRON_LIST_MAX, "the page size is clamped at the ceiling");
  assert.equal(over.jobs.length, Math.min(CRON_LIST_MAX, over.total), "and returns what exists, not padding");
  const beyond = shapeCronList(mixed(), { offset: 500 });
  assert.equal(beyond.jobs.length, 0);
  assert.match(beyond.header, /showing none of 116/);
});

test("与现状对比：默认输出不再随舰队物化线性膨胀", () => {
  // The old tool printed every job. Measure what the default page costs now.
  const jobs = mixed();
  const oldLines = jobs.length;
  const v = shapeCronList(jobs);
  assert.ok(v.jobs.length * 5 < oldLines, `${v.jobs.length} rows vs ${oldLines} before`);
  assert.deepEqual(CRON_SCOPES, ["user", "fleet", "all"]);
});

// ── 上次结果的表述按历史行**类型**分流（fix-rotation-ignores-missed-history）──
//
// 原实现是 `row.success ? "ok" : \`failed: ${row.error || "?"}\``：对
// `{success:null, missed:N}`（到期没跑）与校准留痕都印成 `failed: ?`。这正是
// server/history-kinds.js 开头记的那个「被读成失败 89.7%」的形状，只是搬到了
// MCP 读面上——agent 读到它会去追一个并不存在的故障。
const { lastOutcomeLabel } = await import("../server/cron-list-view.js");

test("last: a missed row is 'due, never started', never a failure", () => {
  assert.equal(lastOutcomeLabel({ kind: "missed", success: null, missed: 8 }), "missed ×8 (due, never started)");
  assert.equal(lastOutcomeLabel({ kind: "missed", success: null }), "missed (due, never started)");
  for (const row of [{ kind: "missed", success: null, missed: 8 }, { kind: "missed", success: null }]) {
    assert.ok(!String(lastOutcomeLabel(row)).startsWith("failed"), "must not read as failed");
  }
});

test("last: metadata rows are neutral, not failures", () => {
  assert.equal(lastOutcomeLabel({ kind: "meta", success: null, note: "calibration" }), null);
  assert.equal(lastOutcomeLabel({ kind: "queued-upgrade", state: "queued", success: null }), null);
});

test("last: a superseded row says so instead of 'failed: ?'", () => {
  assert.equal(lastOutcomeLabel({ kind: "superseded", success: false, supersededBy: "job_newer" }),
    "superseded by a newer round");
});

test("last: real executions keep the ok / failed+reason split", () => {
  assert.equal(lastOutcomeLabel({ kind: "execution", state: "done", success: true }), "ok");
  assert.equal(lastOutcomeLabel({ kind: "execution", state: "failed", success: false, error: "502 upstream" }),
    "failed: 502 upstream");
  assert.equal(lastOutcomeLabel({ kind: "execution", state: "failed", success: false }), "failed: ?");
});

test("last: pre-kind rows classify exactly like the writer's own fallback", () => {
  assert.equal(lastOutcomeLabel({ success: null, missed: 3 }), "missed ×3 (due, never started)");
  assert.equal(lastOutcomeLabel({ success: null, note: "calibration 2026-11-01" }), null);
  assert.equal(lastOutcomeLabel({ state: "failed", success: false, error: "boom" }), "failed: boom");
  assert.equal(lastOutcomeLabel({ state: "done", success: true }), "ok");
});

test("last: no row at all is no label (the caller says 'never run')", () => {
  assert.equal(lastOutcomeLabel(null), null);
  assert.equal(lastOutcomeLabel(undefined), null);
});
