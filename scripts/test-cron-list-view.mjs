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
