// fix-softstop-outcome-marker — 「被故意停下以便捞回」必须与「回合炸了」在读面上分得开。
//
// 现状（2026-11-14 线上实测）：`collectTurn` 在预算软停时 reject 一个带
//   err.earlyStop = true
//   err.detail.budgetSoftStop = true
// 的 error，并在注释里写明「『这轮没拿到预算』与『这轮被故意停下以便捞回』是不同的
// 操作员故事」；runner 的另一个接缝（cron-runner.js:809）也专门保留了 detail，注释
// 说丢掉标记「特性就等于存在但什么也没做」。
//
// 但**任务路径的 catch 只把 message 与 interrupted 交出去**：
//   task-engine.js:1618  finishExecution(t, startTime, { ok:false, error: msg, interrupted })
// 于是 `budgetSoftStop` 到不了 history 行，而 `finishExecution` 里已有同形的先例
// （`skippedReason: "budget_exhausted"`，注释：「不标原因的话读面只能看到『跳过了』」）。
//
// 线上后果（同一天实测）：1904 条任务里 8 条的末条执行是
//   {"state":"failed","success":false,"error":"turn stopped early — budget soft stop (480s of 600s)"}
// —— 与真正的失败逐字同形（同样的 keys、同样的 state），区分只能靠对 error 文本做正则。
// 那些「有输出但被预算截断」的轮因此永远计入连续失败。
//
// 本文件 ①③⑤ 是回归守卫：把 finishExecution 里那行 softStop 标记撤掉，①⑤ 转红
// （⑤ 是工人车道形状：**正常返回** `{ok:false, detail:{…}}`，不是 throw——见 ⑤ 的注释）；
// 把 catch 里的 detail 传递撤掉，③ 转红。②④⑥ 是对照（普通失败不被误标、成功轮不标、
// 工人车道的普通失败既不标 softStop 也不标 contextPressure，但「没问收尾」要留痕）。
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import schedule from "node-schedule";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "softstop-marker-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

// 必须**在设好 env 之后**动态导入：`JOBS_FILE` 在 task-engine 模块求值时就由
// CRON_STORAGE_PATH 定死，静态 import 会把 env 赋值甩在后面（导入被提升），
// 于是落点变成 CWD 下的 `cron-store/jobs.json` —— 测试就此写进仓库工作树、
// 并且与其它用例共用同一份 store（实测「Loaded N task(s)」逐条上涨即是此因）。
const engine = await import("../task-engine.js");
const cron = await import("../cron.js");

test.after(async () => {
  await new Promise((resolve) => schedule.gracefulShutdown(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 与生产同形：cron-runner 的 collectTurn 软停时 reject 的对象。
function softStopError() {
  const err = new Error("turn stopped early — budget soft stop (480s of 600s)");
  err.earlyStop = true;
  err.detail = { budgetSoftStop: true, elapsedMs: 480_000, budgetMs: 600_000, softStopAtMs: 480_000, reported: true };
  return err;
}

async function boot(turnImpl) {
  await cron.initCron({ broadcast: () => {}, runJobTurn: turnImpl, isBusy: () => false });
}

async function runOnce(id) {
  await cron.runJobNow(id);
  for (let i = 0; i < 80; i += 1) {
    const rec = engine.getRecord(id);
    if (rec && rec.state !== "running" && rec.state !== "queued") return rec;
    await new Promise((r) => setTimeout(r, 40));
  }
  return engine.getRecord(id);
}

function lastExecution(rec) {
  const rows = (rec?.history ?? []).filter((h) => h.kind === "execution");
  return rows[rows.length - 1] ?? null;
}

test("① REGRESSION: a budget soft stop is persisted as such, not as an anonymous failure", async () => {
  await boot(async () => {
    throw softStopError();
  });
  const job = await cron.addJob({ prompt: "soft-stopped", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  const row = lastExecution(rec);

  assert.ok(row, "the round must be recorded");
  assert.equal(row.success, false, "a soft stop is still not a success (the round did not finish)");
  assert.equal(row.softStop, true, "but the row must say WHY it stopped");
  // 状态本身不变（仍是 failed）：本变更只补原因，不改既有的成功/失败口径。
  assert.equal(row.state, "failed");
});

test("② control: an ordinary failure carries no soft-stop marker", async () => {
  await boot(async () => {
    throw new Error("Connection error.");
  });
  const job = await cron.addJob({ prompt: "plain-failure", cron: "0 9 * * *" });
  const row = lastExecution(await runOnce(job.id));
  assert.equal(row.success, false);
  assert.equal(row.softStop ?? null, null, "a plain failure must not claim to be a soft stop");
});

test("③ REGRESSION: the marker reaches STORAGE, not just the in-memory record", async () => {
  // 这个缺陷的本质是「标记到不了落盘的地方」：线上读的是 jobs.json 里的 history 行。
  // 所以判据不能只看 getRecord()（内存里的活记录），必须看磁盘。
  await boot(async () => {
    const err = softStopError();
    err.message = "turn stopped early";
    throw err;
  });
  const job = await cron.addJob({ prompt: "detail-only", cron: "0 9 * * *" });
  await runOnce(job.id);
  await engine.saveTasks();

  const jobsFile = path.join(tmpRoot, "jobs.json");
  const listing = fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot).join(",") : "(no dir)";
  assert.ok(fs.existsSync(jobsFile), `expected the store at ${jobsFile}; dir has: ${listing}`);
  const raw = fs.readFileSync(jobsFile, "utf8");
  // 落盘是缩进过的 JSON（`"softStop": true`），所以空格要容忍 —— 判据是「键在且为真」，
  // 不是「序列化风格与我的正则一致」。
  assert.match(raw, /"softStop":\s*true/, "the persisted store must carry the marker, not only the in-memory record");
});

test("④ control: a successful round carries no marker", async () => {
  await boot(async () => ({ ok: true }));
  const job = await cron.addJob({ prompt: "ok", cron: "0 9 * * *" });
  const row = lastExecution(await runOnce(job.id));
  assert.equal(row.success, true);
  assert.equal(row.softStop ?? null, null);
});

// ⑤⑥ REGRESSION（2026-11-15）：**工人车道是另一条形状**。
// `server/worker-slots.js` 的软停不走抛错，而是被它自己的 catch 接住后
// `settle({ ok:false, error, interrupted, detail })` **正常返回**；`settle()` 原样返回
// 不摊平，所以原因留在 `result.detail` 里。①②③④ 全是 `throw`，只证明抛错路径。
// 只读顶层 `result.budgetSoftStop` 时，工人车道的标记在这里被丢掉——而工人车道自陈
// 承载大部分流量（worker-slots.js 的 salvage 注释：131 轮软停里 130 轮两边都没键）。
// 把 ⑤ 转红只需把 finishExecution 里的 `turnDetail?.budgetSoftStop` 那一半删掉。
function workerSettled(extraDetail = {}, extra = {}) {
  return {
    ok: false,
    error: "turn stopped early — budget soft stop (480s of 600s)",
    interrupted: false,
    detail: {
      budgetSoftStop: true,
      elapsedMs: 480_000,
      budgetMs: 600_000,
      softStopAtMs: 480_000,
      reported: false,
      // 收尾车道的结论：这一轮有没有交出一份报告。此前只活在内存里。
      wrapUp: { ok: true, chars: 137 },
      ...extraDetail,
    },
    ...extra,
  };
}

test("⑤ REGRESSION: a worker-lane settled failure keeps its soft-stop reason (nested detail)", async () => {
  await boot(async () => workerSettled());
  const job = await cron.addJob({ prompt: "worker-soft-stop", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  const row = lastExecution(rec);

  assert.equal(row.success, false, "a soft stop is still not a success");
  assert.equal(row.softStop, true, "the worker lane's nested detail must reach the row");
  // 收尾结论也必须在行上：读面要能答「软停后交没交东西」，而不是对着 error 文本猜。
  assert.deepEqual(row.wrapUp, { ok: true, chars: 137 }, "the wrap-up verdict must be on the row");
  // 而且要在**落盘**之后仍然在（线上读的是 jobs.json，不是内存）。
  await engine.saveTasks();
  const raw = fs.readFileSync(path.join(tmpRoot, "jobs.json"), "utf8");
  assert.match(raw, /"softStop":\s*true/, "the persisted store must carry the soft-stop marker");
  assert.match(raw, /"wrapUp":\s*\{/, "and the wrap-up verdict must survive to disk");
});

test("⑥ control: a worker-lane plain failure claims neither marker", async () => {
  await boot(async () => ({
    ok: false,
    error: "Connection error.",
    detail: { reported: false, salvageSkipped: { isFleet: false, interrupted: false, pressure: false, softStop: false, reported: false } },
  }));
  const job = await cron.addJob({ prompt: "worker-plain-failure", cron: "0 9 * * *" });
  const row = lastExecution(await runOnce(job.id));
  assert.equal(row.success, false);
  assert.equal(row.softStop ?? null, null, "a plain failure must not claim to be a soft stop");
  assert.equal(row.contextPressure ?? null, null);
  assert.equal(row.wrapUp ?? null, null);
  // 但「没问过收尾」这件事本身要被记下来（否则与「问过且失败」同形）。
  assert.equal(row.salvageSkipped?.softStop, false, "declined salvage must be recorded with its reasons");
});
