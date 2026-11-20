// Unit tests — interrupted-beat makeup must survive the boot ORDERING
// (add-rollout-gap-durability, defect found 2026-11-15 in production).
//
// The defect: `sweepOpenRuns()` runs at server.js top level, i.e. BEFORE
// `cron.initCron` (server.js:1779 Promise.all) has loaded a single record. So
// `makeUpInterruptedBeat` looked up an empty task list, returned `no-task`, and
// the sweep closed the header — the hourly follow-up never saw it again. The
// whole makeup path was dead on the one decision it ever gets, and the log line
// (`not made up (no-task)`) read like "there is no such post" while the post sat
// in jobs.json.
//
// Pins:
//   - before the engine loads, the verdict is `deferred` and the run is parked
//     (NOT `no-task` — "engine not ready" and "no such post" must not share a
//     verdict, or the difference is invisible in the only log we keep)
//   - after initCron, `drainPendingMakeups()` decides it: makeup + catchUpPending
//   - a paused post, or one with no matching record, still verdicts `no-task`
//     after the drain (the deferral must not turn "nothing to do" into "makeup")
//   - the kill switch still short-circuits, and draining twice decides once
//
// Run: node --test scripts/test-cron-interrupted-beat-boot-order.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Storage env must land BEFORE the cron.js import (module-load-time constant).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-beat-order-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.PLATFORM_CRON_CATCHUP;

const cron = await import("../cron.js");
const engine = await import("../task-engine.js");
const JOBS_FILE = path.join(tmpRoot, "jobs.json");

test.after(() => {
  cron.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const FLEET = "f_boot";
const MEMBER = "m_boot";

// A daily post whose last beat was killed 1h ago — well inside the 48h window
// (2 × 24h cadence).
const dailyRecord = (over = {}) => ({
  id: "job_boot_daily",
  type: "recurring",
  cron: "30 9 * * 1-5",
  prompt: "日报",
  state: "interrupted",
  status: "scheduled",
  paused: false,
  lastRun: new Date(Date.now() - 3_600_000).toISOString(),
  nextRun: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: Date.now() - 86_400_000 * 30,
  history: [],
  sourceTag: { fleetId: FLEET, memberId: MEMBER },
  ...over,
});

async function bootWith(records) {
  await engine.saveTasks();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(records));
  await cron.initCron({ broadcast: () => {}, runJobTurn: async () => ({ ok: true }), isBusy: () => false });
  await engine.idle();
}

test("引擎未载入时判 deferred 并挂起——不是 no-task（这正是上线后从头错到尾的那一档）", async () => {
  assert.equal(cron.isEngineInitialized(), false, "前置：进程刚起来、引擎还没载入");
  const verdict = cron.makeUpInterruptedBeat({ fleetId: FLEET, memberId: MEMBER, runId: "run_parked" });
  assert.equal(verdict, "deferred", "未载入 ⇒ deferred（不是 no-task）");
});

test("载入后 drain：挂起的那一轮真的进补跑（catchUpPending + 一次 fire）", async () => {
  await bootWith([dailyRecord()]);
  assert.equal(cron.isEngineInitialized(), true);
  const counts = cron.drainPendingMakeups();
  assert.equal(counts.makeup, 1, "载入后统一裁决 ⇒ makeup");
  assert.equal(counts["no-task"], 0);
  const rec = engine.getRecord("job_boot_daily");
  assert.equal(rec.catchUpPending, true, "补跑标记落在记录上（读面据此显示【补跑】）");
});

test("drain 幂等：再跑一次什么都不做", async () => {
  const counts = cron.drainPendingMakeups();
  assert.equal(counts.makeup, 0);
  assert.equal(counts["no-task"], 0);
  assert.equal(counts["outside-tolerance"], 0);
});

test("暂停的岗位：载入后仍判 no-task（deferred 不许把「没活干」变成 makeup）", async () => {
  await bootWith([dailyRecord({ id: "job_boot_paused", paused: true })]);
  assert.equal(cron.makeUpInterruptedBeat({ fleetId: FLEET, memberId: MEMBER, runId: "run_paused" }), "no-task");
});

test("没有对应记录的成员：载入后仍判 no-task", async () => {
  await bootWith([dailyRecord()]);
  assert.equal(cron.makeUpInterruptedBeat({ fleetId: FLEET, memberId: "m_nobody", runId: "run_x" }), "no-task");
});

test("超出容差窗口：判 outside-tolerance（不拿今天的库存补几天前那一轮）", async () => {
  await bootWith([dailyRecord({ id: "job_boot_old", lastRun: new Date(Date.now() - 5 * 86_400_000).toISOString() })]);
  assert.equal(cron.makeUpInterruptedBeat({ fleetId: FLEET, memberId: MEMBER, runId: "run_old" }), "outside-tolerance");
});

test("下一个槽位马上就到 ⇒ superseded，不补（生产实证：补跑与常规轮相隔 261 秒）", async () => {
  // 2026-11-15 m_1792910486604_bbkafz：补跑 12:13 起跑、常规轮 12:17 起跑，
  // 同一岗位 261 秒内两遍，第二遍踩在同一小时槽位上。判据取 nextRun 与现在的差。
  await bootWith([dailyRecord({ id: "job_soon" })]);
  // nextRun 必须在 initCron 之后改：排期 pass 会按 cron 重算它，种在 seed 里的
  // 值当场就被覆盖（第一版测试就是这么造出假绿的——读到的是真槽位、判 makeup）。
  engine.getRecord("job_soon").nextRun = new Date(Date.now() + 4 * 60_000).toISOString();
  assert.equal(cron.makeUpInterruptedBeat({ fleetId: FLEET, memberId: MEMBER, runId: "run_soon" }), "superseded");
  assert.ok(!engine.getRecord("job_soon").catchUpPending, "不补就不打补跑标记");
});

test("下一个槽位还远 ⇒ 照常补（同一函数，只改 nextRun）", async () => {
  await bootWith([dailyRecord({ id: "job_later" })]);
  engine.getRecord("job_later").nextRun = new Date(Date.now() + 6 * 3_600_000).toISOString();
  assert.equal(cron.makeUpInterruptedBeat({ fleetId: FLEET, memberId: MEMBER, runId: "run_later" }), "makeup");
  assert.equal(engine.getRecord("job_later").catchUpPending, true);
});

test("窗口可用环境变量调：把门槛压到 0 分钟，4 分钟后的槽位不再算 superseded", async () => {
  process.env.PLATFORM_CRON_MAKEUP_SUPERSEDE_MIN = "0";
  try {
    await bootWith([dailyRecord({ id: "job_tune" })]);
    engine.getRecord("job_tune").nextRun = new Date(Date.now() + 4 * 60_000).toISOString();
    assert.equal(cron.makeUpInterruptedBeat({ fleetId: FLEET, memberId: MEMBER, runId: "run_tune" }), "makeup");
  } finally {
    delete process.env.PLATFORM_CRON_MAKEUP_SUPERSEDE_MIN;
  }
});

test("kill switch 优先于一切（含未载入）", async () => {
  process.env.PLATFORM_CRON_CATCHUP = "0";
  try {
    assert.equal(cron.makeUpInterruptedBeat({ fleetId: FLEET, memberId: MEMBER, runId: "run_sw" }), "kill-switch");
  } finally {
    delete process.env.PLATFORM_CRON_CATCHUP;
  }
});
