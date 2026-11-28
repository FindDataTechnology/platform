// fix-cron-maxruns-on-recurring — 有限次上限必须对**每一种循环形态**都成立。
//
// 规格 `cron-module` 的 "Finite runs close themselves out" 早就写明：
//   A recurring task with a maximum run count SHALL count completed scheduled executions
//   … transition to `completed` on reaching the cap, stop firing …
// 实现只做到了 interval 一条路：`runs` 只在 `onIntervalFinished` 里自增，而那个函数首行
// 是 `if (!task.interval) return;` ⇒ cron 的 `maxRuns` 被接受（validateCron 明确放行）
// 却永不计数。线上 2026-11-14 实见：job_1793545719158_u4ar00 声明 maxRuns:1、
// history 里 5 次真跑过、`runs` 仍是 0。
//
// 本文件的 ①③ 是本缺陷的回归守卫：把 cron.js 里那段早返回改回「非 interval 即返回」，
// 它们必须转红。
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import schedule from "node-schedule";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-maxruns-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

// 必须**在设好 env 之后**动态导入：`JOBS_FILE` 在 task-engine 模块求值时就由
// CRON_STORAGE_PATH 定死，静态 import 会被提升到前面，于是 store 落成 CWD 下的
// `cron-store/jobs.json` —— 测试写进仓库工作树、还与其它用例共用同一份 store。
const engine = await import("../task-engine.js");
const cron = await import("../cron.js");

test.after(async () => {
  await new Promise((resolve) => schedule.gracefulShutdown(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function boot() {
  await cron.initCron({
    broadcast: () => {},
    runJobTurn: async () => ({ ok: true }),
    isBusy: () => false,
  });
}

// 一次真实执行（走 runJobNow → fireTask → runTurn → 完成钩子），与生产同一条路。
async function runOnce(id) {
  await cron.runJobNow(id);
  // runJobNow 内部是异步 fireTask；等它对记录落定。
  for (let i = 0; i < 60; i += 1) {
    const rec = engine.getRecord(id);
    if (rec && rec.state !== "running" && rec.state !== "queued") return rec;
    await new Promise((r) => setTimeout(r, 50));
  }
  return engine.getRecord(id);
}

test("① capped cron task retires at its cap", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "cap-cron", cron: "0 9 * * *", maxRuns: 2 });
  assert.equal(engine.getRecord(job.id).runs ?? 0, 0, "fresh capped cron starts at 0");

  const afterFirst = await runOnce(job.id);
  assert.equal(afterFirst.runs, 1, "first completed round is counted");
  assert.equal(afterFirst.status, "scheduled", "still armed below the cap");

  const afterSecond = await runOnce(job.id);
  assert.equal(afterSecond.runs, 2, "second completed round is counted");
  assert.equal(afterSecond.status, "completed", "reaching the cap retires the task");
  assert.equal(afterSecond.nextRun ?? null, null, "a retired task exposes no next occurrence");
  assert.equal(engine.getRecord(job.id).job ?? null, null, "the timer handle is cancelled");
});

test("② uncapped cron task keeps its counter untouched", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "no-cap", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  assert.equal(rec.runs ?? 0, 0, "without a cap the counter must not advance");
  assert.equal(rec.status, "scheduled", "and the task stays armed as before");
});

test("③ capped cron task below its cap keeps one firing handle", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "cap-3", cron: "0 9 * * *", maxRuns: 3 });
  const rec = await runOnce(job.id);
  assert.equal(rec.runs, 1);
  assert.notEqual(rec.status, "completed", "one round of three must not retire it");
  // 重新武装只属于 interval:cron 的句柄自己会重复,这里再 scheduleJob 会挂出第二个定时线。
  assert.ok(rec.job, "the cron handle is still present");
  const armed = rec.job.nextInvocation?.();
  assert.ok(armed, "the surviving handle is actually armed");
});

test("④ capped interval task behaviour is unchanged", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "cap-interval", interval: { number: 40, unit: "day" }, maxRuns: 2 });
  const first = await runOnce(job.id);
  assert.equal(first.runs, 1, "interval still counts");
  assert.equal(first.status, "scheduled");
  const second = await runOnce(job.id);
  assert.equal(second.runs, 2);
  assert.equal(second.status, "completed", "interval retires at its cap exactly as before");
});

test("⑤ a legacy record with history but runs=0 is not retired before running again", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "legacy-cap", cron: "0 9 * * *", maxRuns: 1 });
  const rec = engine.getRecord(job.id);
  // 模拟线上那条:history 里已有 5 条真执行,但 runs 仍是 0(旧代码从不计数)。
  rec.runs = 0;
  rec.history = [
    { kind: "execution", time: "2026-11-03T09:00:00Z", state: "done", success: true, attempt: 1 },
    { kind: "execution", time: "2026-11-04T09:00:00Z", state: "done", success: true, attempt: 1 },
    { kind: "execution", time: "2026-11-05T09:00:00Z", state: "done", success: true, attempt: 1 },
    { kind: "execution", time: "2026-11-06T09:00:00Z", state: "done", success: true, attempt: 1 },
    { kind: "execution", time: "2026-11-07T09:00:00Z", state: "done", success: true, attempt: 1 },
  ];
  assert.notEqual(rec.status, "completed", "history must not seed the counter into retirement");

  const after = await runOnce(job.id);
  assert.equal(after.runs, 1, "the counter moves by exactly one round");
  assert.equal(after.status, "completed", "and then the declared cap of 1 takes effect");
});
