// fix-cron-tz-edit-validation — 时区校验必须在**每个写面**上成立。
//
// 缺陷原型(线上 2026-11-14 实见):`job_1793545719158_u4ar00` 的 `tz` 是 `"Shanghai"`
// (不是 IANA 名),而 `CronDate`/`Intl` 对同一值同样抛错 ⇒ 引擎解析不出排期,任务静默停摆 7 天,
// 而 `status` 仍停在 `scheduled`、`paused: false`。根因是 `updateJob` 只在**同一次请求也带
// cron** 时才校 tz,而 `cron.tasks.update` 允许只传 tz。
//
// 本文件守的就是那条绕过路径 —— 第 ③ 条用例是本缺陷的回归守卫:
// 把 cron.js 里 updateJob 的 `validateTimezone(tz)` 撤掉,它必须转红。
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import schedule from "node-schedule";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-tz-"));
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

const BAD = "Shanghai"; // 真实存在但**不是** IANA 名;IANA 名是 Asia/Shanghai
const GOOD = "Asia/Shanghai";

test("① create with a resolvable timezone stores it", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "tz-ok", cron: "0 9 * * *", tz: GOOD });
  assert.equal(job.tz, GOOD);
});

test("② create with an unresolvable timezone is rejected, and the error names the timezone", async () => {
  await boot();
  await assert.rejects(
    () => cron.addJob({ prompt: "tz-bad", cron: "0 9 * * *", tz: BAD }),
    (err) => {
      // 关键:表达式是对的(`0 9 * * *`),错的是时区 ⇒ 文案不许指向 cron 表达式。
      assert.match(err.message, /timezone|Asia\/Shanghai/i, `error should name the timezone, got: ${err.message}`);
      assert.doesNotMatch(err.message, /invalid cron expression/i, `must not blame the expression: ${err.message}`);
      return true;
    },
  );
});

test("③ REGRESSION: editing ONLY the timezone is validated too (the live defect's path)", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "tz-edit", cron: "0 9 * * *", tz: GOOD });
  // 这正是 `cron.tasks.update` 只带 tz 时发出的形状:没有 cron。
  await assert.rejects(
    () => cron.updateJob(job.id, { tz: BAD }),
    /timezone|Asia\/Shanghai/i,
    "a timezone-only edit must be rejected",
  );
  // 而且被拒之后**盘上原值不变** —— 校验必须发生在落盘之前。
  const after = engine.getRecord(job.id);
  assert.equal(after.tz, GOOD, "a rejected edit must not change the stored timezone");
  assert.equal(after.cron, "0 9 * * *", "the expression must be untouched");
});

test("④ a valid timezone-only edit applies and leaves the expression alone", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "tz-move", cron: "30 7 * * *", tz: "UTC" });
  const updated = await cron.updateJob(job.id, { tz: GOOD });
  assert.equal(updated.tz, GOOD);
  assert.equal(updated.cron, "30 7 * * *", "editing the timezone must not rewrite the schedule");
});

test("⑤ a legitimate expression with a bad timezone reports the timezone, not the expression", async () => {
  await boot();
  await assert.rejects(
    () => cron.addJob({ prompt: "tz-when", when: new Date(Date.now() + 3_600_000).toISOString(), tz: BAD }),
    /timezone|Asia\/Shanghai/i,
    "a non-cron form must validate the timezone as well",
  );
});

test("⑥ existing records carrying a bad timezone stay readable (no rewriting, no read-path break)", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "tz-legacy", cron: "0 9 * * *", tz: GOOD });
  // 直接写坏值,模拟收紧校验之前的存量数据。
  const rec = engine.getRecord(job.id);
  rec.tz = BAD;
  const list = await cron.listJobs();
  const found = (list?.jobs ?? list ?? []).find((j) => j.id === job.id);
  assert.ok(found, "the legacy record must still be listed");
  assert.equal(found.tz, BAD, "validation must not rewrite existing values on read");
});
