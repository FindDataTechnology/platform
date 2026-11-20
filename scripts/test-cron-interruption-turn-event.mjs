// Unit tests — interrupted executions land a turn event (fix-interrupted-turn-event-on-restart).
//
// The defect: the engine's load-time rewrite (running → interrupted) never
// reaches settle(), so the turn table gains NO row for a restart-killed
// execution — while the spec (agent-fleet-core「回合结果事件」) counts
// interrupted among the four statuses and among "real turns" for presence.
// Live 2026-11-15: 103 of 877 jobs sat in that state (102 unpaused); a daily
// post lost a whole day and every turn-table-based gate read it as healthy.
//
// Pins:
//   - the load-time rewrite stamps `interruptedAt` exactly once (not refreshed
//     by later reloads — the record is no longer running)
//   - the boot sweep records exactly ONE event per interrupted record through
//     the injectable seams, and is idempotent on a second pass
//   - the real shaper classifies this outcome as status=interrupted,
//     errorKind=cell_restart (the wording is pinned to the load-time rewrite)
//   - a record without fleet attribution produces no event and no failure
//   - other states are untouched
//   - a recorder failure does not throw, does not mark, and is retried on the
//     next sweep
//
// Run: node --test scripts/test-cron-interruption-turn-event.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Storage env must land BEFORE the cron.js import (module-load-time constant).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-interrupt-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const cron = await import("../cron.js");
const engine = await import("../task-engine.js");
const { shapeTurnOutcome, classifyErrorKind } = await import("../server/fleet-events.js");
const JOBS_FILE = path.join(tmpRoot, "jobs.json");

test.after(() => {
  cron.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// A fleet-tagged running record, exactly the shape a live restart leaves.
const runningRecord = (over = {}) => ({
  id: "job_1",
  type: "recurring",
  cron: "30 9 * * 1-5",
  prompt: "日报",
  preset: "daily-report",
  state: "running",
  status: "running",
  paused: false,
  lastRun: new Date(Date.now() - 3_600_000).toISOString(),
  nextRun: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: Date.now() - 86_400_000,
  history: [],
  sourceTag: { fleetId: "f_1", memberId: "m_1" },
  ...over,
});

async function bootWith(records) {
  await engine.saveTasks(); // drain the previous boot's write chain
  fs.writeFileSync(JOBS_FILE, JSON.stringify(records));
  await cron.initCron({
    broadcast: () => {},
    runJobTurn: async () => ({ ok: true }),
    isBusy: () => false,
  });
  await engine.idle();
  cron.shutdown();
}

test("载入把 running 改写为 interrupted 且盖 interruptedAt 戳；再次载入不刷新", async () => {
  await bootWith([runningRecord()]);
  const t = engine.getRecord("job_1");
  assert.equal(t.state, "interrupted");
  assert.equal(t.error, "cell restarted during execution");
  assert.ok(Number.isFinite(t.interruptedAt), "检测时刻已落戳");
  const first = t.interruptedAt;

  // Second boot: the record is no longer running, so the rewrite branch must
  // not run again and must not refresh the stamp (it is the ONLY evidence of
  // when the restart happened). Re-seed from what the first boot persisted —
  // jobs.json IS an array, so it feeds bootWith directly (wrapping it again
  // would seed [[record]] and load nothing).
  await bootWith(JSON.parse(fs.readFileSync(JOBS_FILE, "utf8")));
  const again = engine.getRecord("job_1");
  assert.equal(again.state, "interrupted");
  assert.equal(again.interruptedAt, first, "第二次载入不刷新 interruptedAt");
});

test("sweep 对打断记录恰好落一行事件并打标；第二次 sweep 零写入", async () => {
  await bootWith([runningRecord()]);
  const rows = [];
  const recordEvent = (job, outcome, meta) => rows.push({ job: job.id, outcome, meta });
  const markRecorded = (id) => engine.markInterruptionRecorded(id);
  const now = Date.now();

  const first = cron.sweepInterruptedTurnEvents({ recordEvent, markRecorded, now });
  assert.equal(first.recorded, 1, "恰好记一条");
  assert.equal(first.failed, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job, "job_1");
  assert.equal(rows[0].outcome.ok, false);
  assert.equal(rows[0].outcome.interrupted, true);
  assert.ok(Number.isFinite(rows[0].meta.startedAt) && rows[0].meta.startedAt <= now, "startedAt 有界");
  assert.equal(rows[0].meta.endedAt, now);
  assert.ok(Number.isFinite(engine.getRecord("job_1").interruptionRecordedAt), "已打标");

  const second = cron.sweepInterruptedTurnEvents({ recordEvent, markRecorded, now: now + 1 });
  assert.equal(second.recorded, 0, "幂等：第二次零写入");
  assert.equal(rows.length, 1);
});

test("真实 shaping 把这个结局落成 status=interrupted / errorKind=cell_restart", () => {
  // The sweep hands the outcome to the LIVE recorder; this pins the shaping it
  // will receive — and the error-kind wording is pinned to the load-time
  // rewrite text (the two must agree or the row reads `other`).
  const shaped = shapeTurnOutcome(
    { ok: false, interrupted: true, error: "cell restarted during execution" },
    { model: null, hasAttribution: false },
  );
  assert.equal(shaped.status, "interrupted");
  assert.equal(shaped.errorKind, "cell_restart");
  assert.equal(classifyErrorKind("cell restarted during execution"), "cell_restart");
});

test("无舰队归属的普通定时任务：sweep 照常打标，而真实 recorder 返回 null（不产事件）", async () => {
  await bootWith([{ ...runningRecord({ id: "job_bare" }), sourceTag: undefined }]);
  let calls = 0;
  const first = cron.sweepInterruptedTurnEvents({
    recordEvent: () => {
      calls += 1;
    },
    markRecorded: (id) => engine.markInterruptionRecorded(id),
    now: Date.now(),
  });
  // Attribution filtering is the RECORDER's job (spec: 非舰队回合不产出事件),
  // not the sweep's: the sweep must not pre-filter by sourceTag (that would be a
  // second identity rule). Pin both halves: the sweep still calls the seam and
  // marks the record, while the real recorder answers null for this record.
  assert.equal(calls, 1, "sweep 不自行过滤归属（只有一套身份判定）");
  assert.equal(first.failed, 0);
  assert.equal(first.recorded, 1);
  assert.ok(Number.isFinite(engine.getRecord("job_bare").interruptionRecordedAt));

  const { recordTurnEvent } = await import("../server/fleet-events.js");
  const emptyDb = {
    listFleets: () => [],
    listMembers: () => [],
    appendTurnEvent: () => {
      throw new Error("non-fleet turn must never reach the store");
    },
  };
  const out = recordTurnEvent(emptyDb, engine.getRecord("job_bare"), { ok: false, interrupted: true }, {
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
  });
  assert.equal(out, null, "真实 recorder 对无舰队归属的回合返回 null");
});

test("其他状态一条都不碰", async () => {
  await bootWith([
    runningRecord({ id: "job_ok", state: "done", status: "done" }),
    runningRecord({ id: "job_failed", state: "failed", status: "failed" }),
    runningRecord({ id: "job_queued", state: "queued", status: "queued" }),
    // job_paused 的 state 必须连 status 一起置空：state=null + status="running"
    // 是引擎既有的一条 legacy 改写（→ interrupted 无戳），会被 sweep 正当地补记
    // （它就是一次被打断的执行），不属于「其他状态」。
    runningRecord({ id: "job_paused", state: null, status: "scheduled", paused: true }),
  ]);
  const rows = [];
  const out = cron.sweepInterruptedTurnEvents({
    recordEvent: (job) => rows.push(job.id),
    markRecorded: (id) => engine.markInterruptionRecorded(id),
    now: Date.now(),
  });
  assert.equal(out.recorded, 0);
  assert.equal(rows.length, 0, "非 interrupted 状态零触碰");
});

test("写事件失败：不抛、不打标、下次 sweep 重试", async () => {
  await bootWith([runningRecord()]);
  let calls = 0;
  const first = cron.sweepInterruptedTurnEvents({
    recordEvent: () => {
      calls += 1;
      throw new Error("db locked");
    },
    markRecorded: (id) => engine.markInterruptionRecorded(id),
    now: Date.now(),
  });
  assert.equal(first.failed, 1, "失败被点名");
  assert.equal(first.recorded, 0, "失败不打标");
  assert.ok(!engine.getRecord("job_1").interruptionRecordedAt, "失败不打标（未设置即为空）");

  const second = cron.sweepInterruptedTurnEvents({
    recordEvent: () => {
      calls += 1;
    },
    markRecorded: (id) => engine.markInterruptionRecorded(id),
    now: Date.now(),
  });
  assert.equal(second.recorded, 1, "下次 sweep 重试成功");
  assert.equal(calls, 2);
});

test("历史记录（无 interruptedAt 的既有 interrupted）也补记：startedAt=lastRun、零时长落回真实那天", async () => {
  // 2026-11-15 生产实证：216 条历史记录状态早已持久化为 interrupted、无戳，
  // 旧闸（只认带戳记录）对它们一行不落——恰是最想看见的那批仍然隐形。
  // 零时长 endedAt=startedAt 是库内既有惯例（槽位认领路径写的 interrupted 行
  // dur 1–3ms）；startedAt 取该轮 lastRun ⇒ 日聚合按 started_at 分桶落回真实
  // 那天，不会把 216 条堆到今天。
  const lastRun = new Date(Date.now() - 5 * 86_400_000).toISOString(); // 5 天前那一轮
  await bootWith([runningRecord({ id: "job_legacy", state: "interrupted", status: "interrupted", lastRun })]);
  const t0 = engine.getRecord("job_legacy");
  assert.ok(!Number.isFinite(t0.interruptedAt), "前置：历史记录无戳");
  const rows = [];
  const now = Date.now();
  const out = cron.sweepInterruptedTurnEvents({
    recordEvent: (job, outcome, meta) => rows.push({ job: job.id, outcome, meta }),
    markRecorded: (id) => engine.markInterruptionRecorded(id),
    now,
  });
  assert.equal(out.recorded, 1);
  assert.equal(out.legacy, 1, "legacy 计数点名补记路径");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.startedAt, Date.parse(lastRun), "startedAt=该轮真实起点（日聚合落回真实那天）");
  assert.equal(rows[0].meta.endedAt, rows[0].meta.startedAt, "零时长：endedAt=startedAt（库内惯例）");
  const after = engine.getRecord("job_legacy");
  assert.ok(Number.isFinite(after.interruptedAt), "补盖检测戳");
  assert.ok(Number.isFinite(after.interruptionRecordedAt), "已打标（下次重启不重补）");
});

test("同轮已有 interrupted 行（槽位认领路径写的）：对账跳过、不双记，但仍打标+计数", async () => {
  // 不重复记账（规格 scenario）。dedupe 缝在 server.js 侧查 hasInterruptedTurnNear；
  // 这里钉 sweep 自己的契约：hasEvent=true ⇒ recordEvent 零调用、markRecorded
  // 照打（否则每次重启都重查一遍）、skippedExisting 单独计数（少了它
  // 「本来就有行」与「sweep 瞎了」在日志里同形）。
  await bootWith([runningRecord({ id: "job_dup" })]);
  const rows = [];
  const marks = [];
  const out = cron.sweepInterruptedTurnEvents({
    recordEvent: (job) => rows.push(job.id),
    markRecorded: (id, at) => { marks.push(id); engine.markInterruptionRecorded(id, at); return true; },
    hasEvent: (job, startedAt) => job.id === "job_dup" && Number.isFinite(startedAt),
    now: Date.now(),
  });
  assert.equal(out.recorded, 0, "不落新行");
  assert.equal(out.skippedExisting, 1, "对账跳过单独计数");
  assert.equal(rows.length, 0);
  assert.deepEqual(marks, ["job_dup"], "打标照做（幂等前提）");
});

test("自证能红：摘掉 sweep 的落行，幂等用例必须失败", async () => {
  // Negative control: a sweep that records nothing must NOT satisfy the
  // "exactly one row" contract — otherwise a silent no-op ships as green.
  await bootWith([runningRecord({ id: "job_neg" })]);
  const rows = [];
  cron.sweepInterruptedTurnEvents({
    recordEvent: (job, outcome, meta) => rows.push({ job: job.id, outcome, meta }),
    markRecorded: () => false, // 桩：什么都不标
    now: Date.now(),
  });
  assert.equal(rows.length, 1, "对照臂：recordEvent 仍被调到（否则 sweep 本身瞎了）");
  assert.ok(!engine.getRecord("job_neg").interruptionRecordedAt, "对照臂：不打标");
});
