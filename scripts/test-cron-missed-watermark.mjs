#!/usr/bin/env node
// 停机缺口计数必须**幂等**（2026-11-09 实测缺陷）
//
// 症状（线上）：一个 `10 9 * * *`（每天一次）的 job，一天内 missed=69，
// 其中 8 次集中在两小时里——那两小时正好滚了 4 次版。`countMissedOccurrences`
// 原先从 `lastRun` 一路数到现在，而它在每次启动加载与每次 resume 都会跑，
// 于是同一批历史触发点被反复累加。
//
// 危害不只是数字难看：`missed` 被 health 巡检与队列读面当信号用，
// 假一次就误诊一次（我自己就据此误判过「排队饥饿恶化」）。
//
//   node --test scripts/test-cron-missed-watermark.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cron-missed-"));
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.PLATFORM_DATA_DIR = tmp;

// Imported for its module side effects (cron.js reads the engine at import).
await import("../task-engine.js");
const { countMissedOccurrences } = await import("../cron.js");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function rec(overrides = {}) {
  return {
    id: "j1",
    type: "recurring",
    trigger: "schedule",
    cron: "10 9 * * *",
    tz: "UTC",
    paused: false,
    missed: 0,
    history: [],
    lastRun: new Date(Date.now() - 72 * 3600e3).toISOString(), // 3 天前
    ...overrides,
  };
}

test("the same gap is counted once, not once per load", () => {
  const task = rec();

  const first = countMissedOccurrences(task);
  assert.ok(first > 0, `first load should count the gap, got ${first}`);
  assert.equal(task.missed, first, "counter reflects the first count");
  assert.ok(task.lastMissedCountedUntil, "a watermark must be stamped");

  // 再跑一次 = 模拟重启后的加载；同一批触发点不得再记
  const second = countMissedOccurrences(task);
  assert.equal(second, 0, "re-loading with no new occurrences must count nothing");
  assert.equal(task.missed, first, "counter must not grow on a reload");

  // 第三次、第四次（线上就是滚了 4 次版）
  assert.equal(countMissedOccurrences(task), 0);
  assert.equal(countMissedOccurrences(task), 0);
  assert.equal(task.missed, first, "still stable after repeated loads");
});

test("a genuinely new gap is still counted", () => {
  const task = rec();
  const first = countMissedOccurrences(task);
  assert.ok(first > 0);

  // 水位往前挪一天 → 中间必然又产生了新的触发点（每天 09:10 UTC 一次）
  // 用 lastMissedAt 之外的独立水位字段表达"上次统计到一天前"
  task.lastMissedCountedUntil = new Date(Date.now() - 48 * 3600e3).toISOString();
  const again = countMissedOccurrences(task);
  assert.ok(again > 0, `new occurrences after the watermark must be counted, got ${again}`);
  assert.equal(task.missed, first + again);
});

test("legacy records without the watermark fall back to lastMissedAt", () => {
  // 旧记录只有 lastMissedAt（它正是"上次统计的时刻"），存量不该继续膨胀
  const task = rec({ lastMissedAt: new Date().toISOString(), missed: 69 });
  const counted = countMissedOccurrences(task);
  assert.equal(counted, 0, "a record counted moments ago has no new occurrences");
  assert.equal(task.missed, 69, "legacy counter is left alone");
});

test("records that have never run are not counted", () => {
  const task = rec({ lastRun: null });
  assert.equal(countMissedOccurrences(task), 0, "a never-run task has no gap to count");
  assert.equal(task.missed, 0);
});

test("hitting the per-load cap is stamped, so the count is not read as exact", () => {
  // 每分钟一次、停了 3 小时 = 180 个触发点，超过单次加载上限（100）。
  // 线上这个形状真实存在：一个 task 停了 15 天，watermark 落地前每次加载
  // 都记 100，一天记了 2700——那个数被当成"饥饿"来读。
  const task = rec({
    cron: "* * * * *",
    lastRun: new Date(Date.now() - 3 * 3600e3).toISOString(),
  });
  const missed = countMissedOccurrences(task);
  assert.equal(missed, 100, "the walk stops at the cap");
  const row = task.history.at(-1);
  assert.equal(row.kind, "missed");
  assert.equal(row.missedCapped, true, "a floor must be labelled a floor");
});

test("an uncapped gap is not labelled", () => {
  const task = rec(); // 每天一次、停 3 天 -> 3 个缺口，远低于上限
  const missed = countMissedOccurrences(task);
  assert.ok(missed > 0 && missed < 100);
  assert.equal(task.history.at(-1).missedCapped, undefined);
});
