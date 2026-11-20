// fix-cron-arm-silent-stall —— 「arm 成功却永不跑」必须落成可见的 error。
//
// 缺陷机制（2026-11-15 实测，node-schedule 1.7 + cron-parser）：
//   cronParser.parseExpression("0 9 * * *", { tz: "Shanghai" })  **不抛** —— parse 不校 tz；
//   只有 .next() 才炸（CronDate: unhandled timestamp: null）。
// 而 cron.js 的 arm 路径是 schedule.scheduleJob({ rule, tz }, cb)：
//   坏 tz 时它**同样不抛** —— 返回 false、nextInvocation() 为 null。
//   于是 cron.js scheduleJob 里的 catch 不走，task.status 停在 "scheduled"，
//   任务 arm「成功」却永不触发。写路径的 Intl 闸（validateTimezone）只拦新写入；
//   **存量坏值在每次重启的 arm 时被静默吞掉** —— 线上
//   job_1793545719158_u4ar00（tz="Shanghai"、末次执行 2026-11-07，此后 7 天一条不跑、
//   status 仍 "scheduled"）就是这个形状。
//
// 本文件守的判据：arm 出不来下一次触发 ⇒ 必须落 status:"error" 并点名原因，
// 且**落盘**可见（线上读的是 jobs.json，不是内存记录）。
// 对照（不误伤合法状态）：有效 tz 正常 arm；暂停的坏 tz 任务不报 error——
// 不跑是所有者的本意（scheduleJob 对 paused 直接 return）。
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import schedule from "node-schedule";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-arm-stall-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

// 必须**在设好 env 之后**动态导入：`JOBS_FILE` 在 task-engine 模块求值时就由
// CRON_STORAGE_PATH 定死，静态 import 会被提升到前面，于是 store 落成 CWD 下的
// `cron-store/jobs.json` —— 测试写进仓库工作树、还与其它用例共用同一份 store。
const engine = await import("../task-engine.js");
const cron = await import("../cron.js");

// 存量任务直接写进 store（绕过写路径的 validateTimezone —— 它拦不住已经写坏的历史值）。
// 每行必须带 `history: []`：loadTasks 能容忍缺省，但 updateJob → broadcastStatus →
// clientShape 的 `t.history.slice` 会当场 TypeError（与 paas 仓同款坑）。
const legacyJobs = [
  {
    id: "job_armstall_broken", trigger: "schedule", type: "recurring",
    cron: "0 9 * * *", prompt: "broken-tz", tz: "Shanghai",
    paused: false, status: "scheduled", history: [],
  },
  {
    id: "job_armstall_valid", trigger: "schedule", type: "recurring",
    cron: "0 9 * * *", prompt: "valid-tz", tz: "Asia/Shanghai",
    paused: false, status: "scheduled", history: [],
  },
  {
    id: "job_armstall_paused", trigger: "schedule", type: "recurring",
    cron: "0 9 * * *", prompt: "paused-bad-tz", tz: "Shanghai",
    paused: true, status: "paused", history: [],
  },
];
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), JSON.stringify(legacyJobs, null, 2));

await cron.initCron({ broadcast: () => {}, runJobTurn: async () => ({ ok: true }), isBusy: () => false });

function rec(id) {
  const r = engine.getRecord(id);
  assert.ok(r, `${id} must be loaded from the store`);
  return r;
}

test.after(async () => {
  await new Promise((resolve) => schedule.gracefulShutdown(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("① REGRESSION: a legacy bad-tz task arms VISIBLY broken, not silently scheduled", async () => {
  const r = rec("job_armstall_broken");
  assert.notEqual(r.status, "scheduled", "an unresolvable schedule must not stay 'scheduled'");
  assert.equal(r.status, "error");
  assert.match(
    r.error ?? "",
    /never fire|next invocation/,
    "the error must say WHY (the job would never fire)",
  );
  assert.match(
    r.error ?? "",
    /Shanghai/,
    "the error must name the bad value so the fix is obvious",
  );
});

test("② REGRESSION: the broken arm reaches STORAGE, not just memory", async () => {
  await engine.saveTasks();
  const raw = fs.readFileSync(path.join(tmpRoot, "jobs.json"), "utf8");
  const jobs = JSON.parse(raw);
  const broken = jobs.find((j) => j.id === "job_armstall_broken");
  assert.equal(broken?.status, "error", "the live read face is jobs.json — it must carry the error");
  assert.match(broken?.error ?? "", /never fire|next invocation/);
});

test("③ control: a valid-tz task still arms normally", () => {
  const r = rec("job_armstall_valid");
  assert.equal(r.status, "scheduled");
  assert.ok(r.nextRun, "a valid schedule must produce a next run");
});

test("④ control: a PAUSED bad-tz task is not an error — not running is the owner's intent", () => {
  const r = rec("job_armstall_paused");
  assert.equal(r.paused, true);
  assert.notEqual(r.status, "error", "paused tasks must not be flagged by the arm check");
});

test("⑤ ESCAPE: fixing the cause via updateJob must heal the stale error back to scheduled", async () => {
  // test ① 已让 job_armstall_broken 落在 status:"error"。所有者改好 tz（正是
  // u4ar00 的修复路径）→ in-place 重 arm 会**成功**；若不清掉陈旧的 error，
  // 读面对着一个健康的排期永远报错 —— error 状态必须可逃逸。
  const before = rec("job_armstall_broken");
  assert.equal(before.status, "error", "precondition: the task is in the broken state from ①");
  await cron.updateJob("job_armstall_broken", { tz: "Asia/Shanghai" });
  const after = rec("job_armstall_broken");
  assert.equal(after.status, "scheduled", "a successful re-arm must clear the stale error");
  assert.ok(after.nextRun, "the healed task must have a next run again");
  assert.ok(!after.error, "the stale error message must be cleared, not left dangling");
  // 且落盘可见：jobs.json 里同一样 healed。
  await engine.saveTasks();
  const jobs = JSON.parse(fs.readFileSync(path.join(tmpRoot, "jobs.json"), "utf8"));
  const healed = jobs.find((j) => j.id === "job_armstall_broken");
  assert.equal(healed?.status, "scheduled");
});
