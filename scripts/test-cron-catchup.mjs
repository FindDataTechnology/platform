// Unit tests — downtime catch-up + missed visibility (P2, 2026-10-26).
//
// The defect: a platform restart covering a cron trigger only wrote a log line
// ("missed 1 occurrence(s) during downtime") and jumped nextRun to the next
// period. An unattended fleet post silently lost a delivery and later read
// `missing` with no explanation anywhere but the log.
//
// Pins:
//   - the missed counter carries its reason and timestamp on the task record
//   - the tolerance-window decision (2 × period, 6h floor; kill switch)
//   - the fleet post card / evidence surface the count and the make-up state
//   - a downtime-starved post's `missing` reason names downtime, not a mystery
//   - catch-up marker is spent with its run (never persists past it)
//   - out-of-window lost beats ALERT explicitly on boot (naming task + count),
//     not just record (harden-cell-execution-reliability)
//
// Run: node --test scripts/test-cron-catchup.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Storage env must land BEFORE the cron.js import (module-load-time constant).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-catchup-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const { deriveMemberStatus } = await import("../server/fleet-reconcile.js");
const cron = await import("../cron.js");
const engine = await import("../task-engine.js");
const JOBS_FILE = path.join(tmpRoot, "jobs.json");

test.after(() => {
  cron.shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const _HOUR = 60 * 60 * 1000;
const member = (over = {}) => ({
  id: "m_1",
  fleetId: "f_1",
  title: "巡线岗",
  targetKind: "persona",
  targetId: "persona-a",
  cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  kpiSlots: [],
  ...over,
});
const fleet = { id: "f_1", state: "active" };

test("the task view carries the downtime marker and the catch-up flag", () => {
  // clientShape is module-private; listTasks is its only door. A record with
  // the new fields serializes them through, and an untouched record reads as
  // zeros/nulls — the card must never receive undefined.
  const shaped = (t) => ({
    missed: t.missed ?? 0,
    lastMissedAt: t.lastMissedAt ?? null,
    lastMissedReason: t.lastMissedReason ?? null,
    catchUpPending: t.catchUpPending === true,
  });
  assert.deepEqual(
    shaped({ missed: 2, lastMissedAt: "2026-10-26T01:33:00.000Z", lastMissedReason: "downtime", catchUpPending: true }),
    { missed: 2, lastMissedAt: "2026-10-26T01:33:00.000Z", lastMissedReason: "downtime", catchUpPending: true },
  );
  assert.deepEqual(shaped({}), { missed: 0, lastMissedAt: null, lastMissedReason: null, catchUpPending: false });
});

test("evidence carries missedRounds/lastMissedAt/catchUpPending; defaults are honest", () => {
  const now = Date.parse("2026-10-26T02:00:00Z");
  const task = {
    id: "job_1",
    lastRun: "2026-10-25T01:17:00Z",
    nextRun: "2026-10-27T01:00:00Z",
    missed: 1,
    lastMissedAt: "2026-10-26T01:33:00Z",
    lastMissedReason: "downtime",
    catchUpPending: true,
  };
  const derived = deriveMemberStatus({ member: member(), fleet, task, targetAlive: true, now });
  assert.equal(derived.evidence.missedRounds, 1);
  assert.equal(derived.evidence.lastMissedAt, "2026-10-26T01:33:00Z");
  assert.equal(derived.evidence.lastMissedReason, "downtime");
  assert.equal(derived.evidence.catchUpPending, true);

  // No task / fresh task: zeros and nulls, never undefined (card renders it).
  const bare = deriveMemberStatus({ member: member(), fleet, task: null, targetAlive: true, now });
  assert.equal(bare.evidence.missedRounds, 0);
  assert.equal(bare.evidence.lastMissedAt, null);
  assert.equal(bare.evidence.catchUpPending, false);
});

test("a downtime-starved post names downtime in its missing reason (and the make-up)", () => {
  // Past the 48h window for a daily cadence (last run 10-25 01:17Z).
  const now = Date.parse("2026-10-28T12:00:00Z");
  const task = {
    id: "job_1",
    lastRun: "2026-10-25T01:17:00Z", // > 48h window earlier than now
    missed: 1,
    lastMissedAt: "2026-10-26T01:33:00Z",
    lastMissedReason: "downtime",
    catchUpPending: false,
  };
  const derived = deriveMemberStatus({ member: member(), fleet, task, targetAlive: true, now });
  assert.equal(derived.status, "missing");
  assert.match(derived.reason, /no execution for over the tolerance window/);
  assert.match(derived.reason, /1 round\(s\) skipped by platform downtime/);
  assert.ok(!derived.reason.includes("catch-up"), "no make-up claimed when none is pending");

  const pending = deriveMemberStatus({
    member: member(), fleet,
    task: { ...task, catchUpPending: true },
    targetAlive: true, now,
  });
  assert.match(pending.reason, /catch-up run in flight/);
});

test("a post with no downtime history keeps the byte-identical legacy reason", () => {
  // 48h window (daily cadence): 4 days of silence is past it.
  const now = Date.parse("2026-10-29T12:00:00Z");
  const task = { id: "job_1", lastRun: "2026-10-25T01:17:00Z", missed: 0 };
  const derived = deriveMemberStatus({ member: member(), fleet, task, targetAlive: true, now });
  assert.equal(derived.status, "missing");
  assert.equal(derived.reason, "no execution for over the tolerance window (48h)");
});

test("catch-up window: inside it a make-up is due, outside it is not (and the kill switch wins)", () => {
  const daily = { id: "j", cron: "0 9 * * *", tz: "Asia/Shanghai", lastRun: "2026-10-25T01:17:00Z" };
  // 01:33Z restart, ~2h after the missed trigger: well inside 48h.
  assert.equal(cron.withinToleranceWindow(daily, Date.parse("2026-10-26T03:33:00Z")), true);
  // Five days later: the gap is past saving — a late patrol would only mislead.
  assert.equal(cron.withinToleranceWindow(daily, Date.parse("2026-10-30T12:00:00Z")), false);
  // A task that never ran has no missed round to make up.
  assert.equal(cron.withinToleranceWindow({ ...daily, lastRun: null }, Date.parse("2026-10-26T03:33:00Z")), false);
  // Kill switch suppresses the make-up without touching the missed accounting.
  process.env.PLATFORM_CRON_CATCHUP = "0";
  try {
    assert.equal(cron.withinToleranceWindow(daily, Date.parse("2026-10-26T03:33:00Z")), false);
  } finally {
    delete process.env.PLATFORM_CRON_CATCHUP;
  }
  // Hourly cadence: window = max(2h, 6h floor) = 6h — 3h gap is inside.
  const hourly = { id: "j2", cron: "0 * * * *", tz: null, lastRun: "2026-10-26T00:00:00Z" };
  assert.equal(cron.withinToleranceWindow(hourly, Date.parse("2026-10-26T03:00:00Z")), true);
  assert.equal(cron.withinToleranceWindow(hourly, Date.parse("2026-10-26T08:00:00Z")), false);
});

// ── 窗外丢轮显式告警（harden-cell-execution-reliability）─────────────────────
//
// 完整走 boot pass（initCron 对种子 jobs.json 的真实调度扫描）：窗外丢轮在
// 「只记账」之上必须广播显式告警事件 + 落 WARNING（同缝 metering 直读未配置
// 告警的通道纪律）。告警走引擎既有 WS 事件面，与 cron_* 事件同缝。

const jobRecord = (over = {}) => ({
  id: "job_1",
  trigger: "schedule",
  type: "recurring",
  cron: "0 9 * * *",
  when: null,
  prompt: "morning report",
  preset: "legal-case",
  targetType: "persona",
  sessionId: "cron-job_1",
  tz: "Asia/Shanghai",
  status: "scheduled",
  paused: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  lastRun: null,
  nextRun: null,
  missed: 0,
  history: [],
  ...over,
});

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

// Boot the scheduling front-end against a seeded jobs file and collect the
// broadcast events. shutdown() afterwards cancels the armed node-schedule
// timers so they cannot fire into (or past) the teardown.
async function bootCron(records, runTurn = async () => ({ ok: true })) {
  await engine.saveTasks(); // 排空上一轮 boot 的写链，种子不被迟到写入覆盖
  fs.writeFileSync(JOBS_FILE, JSON.stringify(records));
  const events = [];
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    await cron.initCron({
      broadcast: (e) => events.push(e),
      runJobTurn: runTurn,
      isBusy: () => false,
    });
    await engine.idle();
  } finally {
    console.warn = originalWarn;
    cron.shutdown();
    await engine.saveTasks();
  }
  return { events, warns };
}

test("boot 窗外丢轮：记账之上广播显式告警事件（点名任务与丢轮数）+ WARNING", async () => {
  const { events, warns } = await bootCron([jobRecord({ lastRun: daysAgo(5) })]);

  const task = engine.getTask("job_1");
  assert.ok(task.missed >= 1, "丢轮已记账（既有行为，告警不取代记账）");
  assert.equal(task.lastMissedReason, "downtime");
  assert.ok(task.history.some((h) => h.missed >= 1), "history 落 miss 标记");

  const alerts = events.filter((e) => e.type === "cron_missed_alert");
  assert.equal(alerts.length, 1, "恰好一条显式告警事件");
  assert.equal(alerts[0].id, "job_1");
  assert.ok(Number.isInteger(alerts[0].missed) && alerts[0].missed >= 1, "告警携带丢轮数");
  assert.equal(alerts[0].missed, task.missed, "告警数量与记账一致");
  assert.equal(alerts[0].reason, "outside-tolerance");
  assert.ok(!Number.isNaN(Date.parse(alerts[0].at)), "携带告警时刻");

  assert.equal(warns.length, 1, "恰好一条 WARNING（不静默、不刷屏）");
  assert.match(warns[0], /ALERT: task job_1 lost \d+ beat\(s\)/);
  assert.match(warns[0], /outside-tolerance/);
});

test("boot 窗内丢轮：补跑而非告警", async () => {
  // 小时节奏，2h 前最后运行：窗 = max(2×1h, 6h) = 6h → 窗内 → 补跑一枪
  const { events } = await bootCron([
    jobRecord({ cron: "0 * * * *", tz: null, lastRun: hoursAgo(2) }),
  ]);
  assert.equal(events.filter((e) => e.type === "cron_missed_alert").length, 0, "窗内不告警");
  const task = engine.getTask("job_1");
  assert.ok(task.history.some((h) => h.catchUp === true), "补跑已执行（catchUp 标记落史）");
});

test("boot 暂停任务窗外丢轮：不告警（不跑是所有者的本意）", async () => {
  const { events } = await bootCron([
    jobRecord({ lastRun: daysAgo(5), paused: true, status: "paused" }),
  ]);
  assert.equal(events.filter((e) => e.type === "cron_missed_alert").length, 0);
});

test("boot 暂停任务的缺口不计数、不写历史行（不是饥饿，是本意）", async () => {
  // 线上实测（2026-11-09）：一个 10-25 起就暂停的 `17 * * * *` 任务，每次 cell
  // 重启都记一笔缺口，24h 内积到 2700 次（27 行 × MAX_MISSED_PER_LOAD），
  // 被读成"排队饥饿恶化"。暂停即无义务——连计数都不该发生。
  const { events } = await bootCron([
    jobRecord({ cron: "17 * * * *", lastRun: daysAgo(5), paused: true, status: "paused" }),
  ]);
  const task = engine.getTask("job_1");
  assert.equal(events.filter((e) => e.type === "cron_missed_alert").length, 0);
  assert.equal(task.missed ?? 0, 0, "a paused task accrues no missed count");
  assert.equal(
    (task.history || []).filter((h) => h.kind === "missed" || h.missed).length,
    0,
    "and writes no missed history row",
  );
});

test("恢复不停机的任务仍然计数（暂停不吞掉真正欠下的轮次）", async () => {
  // 反向守卫：不能因为加了 !paused 就把正常任务一起静音。
  await bootCron([jobRecord({ cron: "0 * * * *", lastRun: daysAgo(3) })]);
  const task = engine.getTask("job_1");
  assert.ok((task.missed ?? 0) > 0, `an unpaused task must still accrue, got ${task.missed}`);
});

test("boot kill switch：窗外丢轮仍告警，reason 区分为 catch-up-disabled", async () => {
  process.env.PLATFORM_CRON_CATCHUP = "0";
  try {
    // 本应窗内（2h 前运行的小时任务）：kill switch 关掉的是补跑，不是知情权
    const { events, warns } = await bootCron([
      jobRecord({ cron: "0 * * * *", tz: null, lastRun: hoursAgo(2) }),
    ]);
    const alerts = events.filter((e) => e.type === "cron_missed_alert");
    assert.equal(alerts.length, 1, "kill switch 下照告");
    assert.equal(alerts[0].reason, "catch-up-disabled");
    assert.match(warns[0], /catch-up-disabled/);
  } finally {
    delete process.env.PLATFORM_CRON_CATCHUP;
  }
});
