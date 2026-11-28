// fix-overflow-rotation-reads-the-verdict —— 「下一轮换会话」不许靠读人话。
//
// 现状：`finishExecution` 末尾
//   if (!ok && isContextOverflowError(t.error)) t.rotateNextSession = true;
// 而 `isContextOverflowError` 是**对 error 文本做正则**：
//   /CONTEXT_WINDOW_EXCEEDED|context overflow|context window exceeded|
//    maximum context length|too large for (?:this|the) model/i
//
// 可执行器那边早就有结构化判定：`collectTurn` 在同一轮给出
//   err.detail = { contextPressure: true, overflow: true, kind: "context_overflow", ... }
// （`contextPressureDetail`，cron-runner.js:675）。于是同一条区分又出现两个来源：
// 结构化的是事实，正则的是猜。今天上游/运行时换个措辞（本地化、被包一层、改名），
// 换会话就静默失效 —— 而失效的后果是下一轮继续用那个已经撑爆的会话，每轮都溢出。
//
// 注意量词：`contextPressure` 对「真溢出」与「压缩次数过多」**都为真**（kind 分别是
// context_overflow / turn_budget_exceeded），所以判据必须取 `detail.overflow === true`；
// 拿 contextPressure 当溢出会多换会话，那是另一种错。
//
// 本文件 ①③ 是回归守卫：撤掉 finishExecution 里的结构化优先，① 转红；
// 撤掉 catch 里的 overflow 转发，①③ 转红。②④ 是对照（正则回退仍在、普通失败不换）。
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import schedule from "node-schedule";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "overflow-rotation-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const engine = await import("../task-engine.js");
const cron = await import("../cron.js");

test.after(async () => {
  await new Promise((resolve) => schedule.gracefulShutdown(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

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

// 结构化溢出：文本里**没有任何**溢出关键词，判定只能来自 detail。
function structuredOverflow({ message = "turn stopped early — upstream returned 400", overflow = true, kind = "context_overflow" } = {}) {
  const err = new Error(message);
  err.earlyStop = true;
  err.detail = { kind, contextPressure: true, ...(overflow ? { overflow: true } : {}), compactions: 0, reported: false };
  return err;
}

test("① REGRESSION: the executor's structured overflow rotates the session even when the text says nothing", async () => {
  await boot(async () => {
    throw structuredOverflow();
  });
  const job = await cron.addJob({ prompt: "overflow-structured", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  assert.equal(rec.rotateNextSession, true, "the structured verdict must drive rotation, not the wording");
  assert.equal(rec.state, "failed", "the round still failed");
});

test("② control: a message-only overflow still rotates (the text fallback stays)", async () => {
  await boot(async () => {
    throw new Error("maximum context length exceeded");
  });
  const job = await cron.addJob({ prompt: "overflow-text", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  assert.equal(rec.rotateNextSession, true, "legacy paths without detail must keep working");
});

test("③ REGRESSION: compaction pressure alone does NOT rotate (contextPressure without overflow)", async () => {
  // `turn_budget_exceeded`：压缩次数过多，但没撑爆窗口。换会话不是它该做的事——
  // 拿 contextPressure 当溢出就会在这里多换，那是把一条判据写成两种意思。
  await boot(async () => {
    throw structuredOverflow({ message: "turn stopped early — compacted too often", overflow: false, kind: "turn_budget_exceeded" });
  });
  const job = await cron.addJob({ prompt: "compaction-only", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  assert.notEqual(rec.rotateNextSession, true, "compaction pressure must not be read as an overflow");
});

test("④ the row records the pressure verdict, so a reader can explain the stop", async () => {
  await boot(async () => {
    throw structuredOverflow();
  });
  const job = await cron.addJob({ prompt: "overflow-row", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  const rows = (rec.history ?? []).filter((h) => h.kind === "execution");
  const row = rows[rows.length - 1];
  assert.equal(row?.contextPressure, true, "an early stop for context pressure must say so on the row");
});

test("⑤ control: an ordinary failure records no pressure and rotates nothing", async () => {
  await boot(async () => {
    throw new Error("Connection error.");
  });
  const job = await cron.addJob({ prompt: "plain", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  assert.notEqual(rec.rotateNextSession, true);
  const rows = (rec.history ?? []).filter((h) => h.kind === "execution");
  assert.equal(rows[rows.length - 1]?.contextPressure ?? null, null);
});

// ⑥⑦ REGRESSION（2026-11-15）：**工人车道正常返回，不抛错**。
// `server/worker-slots.js` 把回合失败 `settle({ ok:false, error, interrupted, detail })`
// 正常返回（`settle()` 不摊平），所以 `detail.overflow` 留在 `result.detail` 里。
// ①②③④⑤ 全是 `throw`，只证明抛错路径；只读顶层 `result.contextOverflow` 时，
// 工人车道的溢出判定到不了这里 ⇒ `rotateNextSession` 不置位 ⇒ 下一轮继续用那个
// 已经撑爆的会话、每轮都溢出。判据要同时读两层的**不同名**：扁平 `contextOverflow`
// ↔ 嵌套 `detail.overflow`（这一行改名本身就是「字段在链路中段被改名/丢层」的老形态）。
test("⑥ REGRESSION: a worker-lane settled overflow rotates the session (nested detail.overflow)", async () => {
  await boot(async () => ({
    ok: false,
    error: "turn stopped early — upstream returned 400",
    detail: { kind: "context_overflow", contextPressure: true, overflow: true, compactions: 0, reported: false },
  }));
  const job = await cron.addJob({ prompt: "worker-overflow", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  assert.equal(rec.rotateNextSession, true, "the worker lane's structured overflow must rotate");
  const rows = (rec.history ?? []).filter((h) => h.kind === "execution");
  assert.equal(rows[rows.length - 1]?.contextPressure, true, "and the row must carry the pressure verdict");
});

test("⑦ control: worker-lane compaction pressure without overflow does NOT rotate", async () => {
  await boot(async () => ({
    ok: false,
    error: "turn stopped early — compacted too often",
    detail: { kind: "turn_budget_exceeded", contextPressure: true, compactions: 9, reported: false },
  }));
  const job = await cron.addJob({ prompt: "worker-pressure", cron: "0 9 * * *" });
  const rec = await runOnce(job.id);
  assert.notEqual(rec.rotateNextSession, true, "pressure without `overflow` must not be read as an overflow");
});
