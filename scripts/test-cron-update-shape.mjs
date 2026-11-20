// fix-cron-update-shape — 就地更新只能产出「执行面认账」的形状。
//
// 这一族缺陷的共性：`addJob` 在创建时把某条跨字段约束校死了，`updateJob` 只校验
// **传入的单个字段**，于是同一条约束在编辑面上失效。三处实见（2026-11-14）：
//
//   ① 形态互斥：`interval is exclusive with cron/when`（创建拒绝两种形态并存）。
//      `updateJob` 设 cron 却不清 interval ⇒ 记录同时带两种形态；而 `scheduleJob`
//      取值 `task.interval` 在前 ⇒ 旧节奏继续生效，新表达式只留在记录上给人看。
//   ② tool 目标的 prompt 必须是 JSON 对象（fix-cell-turn-throughput 4.1：2026-11-08
//      线上有 4 条任务每次触发都失败在这上面，重试永远救不了）。`updateJob` 只校
//      「非空字符串」⇒ 把 tool 任务的 prompt 改成非 JSON 会被接受，从下一次触发起
//      每次都失败。
//   ③ `maxRuns requires a recurring form`（创建拒绝在单次任务上设上限）。`updateJob`
//      只校正整数 ⇒ 给单次任务设上限会被接受，而上限永远不会生效。
//   ④ `delayMinutes is exclusive with cron/when/interval`（创建拒绝）。`updateJob`
//      只查 cron/interval，漏了 `when` ⇒ 两者同时给出时 `when` 被静默覆盖。
//
// 判据统一成一句话：**更新后的记录必须是 `addJob` 会接受的形状**。
// 本文件 ①②③⑥⑦⑧ 是回归守卫；④⑤ 是对照（本来就对的路径不许改坏）。
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import schedule from "node-schedule";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-update-shape-"));
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

function hoursToNextRun(rec) {
  const next = rec?.nextRun ? new Date(rec.nextRun).getTime() : NaN;
  assert.ok(Number.isFinite(next), `nextRun should be a real timestamp, got ${rec?.nextRun}`);
  return (next - Date.now()) / 3_600_000;
}

// ── ① 形态互斥 ─────────────────────────────────────────────────────────────

test("① REGRESSION: interval → cron replaces the rule; the old interval must not keep firing", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "switch-to-cron", interval: { number: 40, unit: "day" } });
  assert.ok(engine.getRecord(job.id).interval, "starts as an interval task");

  const updated = await cron.updateJob(job.id, { cron: "0 9 * * *" });

  assert.equal(updated.cron, "0 9 * * *", "the new expression is stored");
  assert.equal(updated.interval ?? null, null, "the stale interval rule must be dropped, not shadowed");
  assert.equal(updated.anchor ?? null, null, "the interval anchor goes with the rule it anchored");
  const h = hoursToNextRun(updated);
  assert.ok(h > 0 && h <= 24.1, `next run must follow the cron rule, got ${h.toFixed(1)}h away`);
});

test("② REGRESSION: interval → one-shot (`when`) also drops the interval", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "switch-to-once", interval: { number: 7, unit: "day" } });
  const when = new Date(Date.now() + 2 * 3_600_000).toISOString();

  const updated = await cron.updateJob(job.id, { when });

  assert.equal(updated.interval ?? null, null, "a one-shot edit must not leave the interval armed");
  assert.equal(updated.type, "once", "the task becomes a one-shot");
  const h = hoursToNextRun(updated);
  assert.ok(h > 0 && h <= 2.1, `next run must be the requested time, got ${h.toFixed(1)}h away`);
});

test("③ REGRESSION: after the switch the record is a shape addJob would accept", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "switch-shape", interval: { number: 1, unit: "day" } });
  const updated = await cron.updateJob(job.id, { cron: "*/15 * * * *" });
  assert.equal(updated.cron != null && updated.interval != null, false, "never carry both forms");
});

// ── ② tool 目标的 prompt 必须是 JSON 对象 ───────────────────────────────────

test("⑥ REGRESSION: a tool task's prompt cannot be edited into a non-JSON string", async () => {
  await boot();
  const job = await cron.addJob({ prompt: '{"query":"x"}', tool: "server::search", cron: "0 9 * * *" });
  assert.equal(engine.getRecord(job.id).targetType, "tool");

  await assert.rejects(
    () => cron.updateJob(job.id, { prompt: "just a sentence, not JSON" }),
    /JSON object/,
    "the update must reject a prompt the turn could never parse",
  );
  // 被拒之后盘上原值不变：校验发生在落盘之前。
  assert.equal(engine.getRecord(job.id).prompt, '{"query":"x"}', "a rejected edit must not overwrite the prompt");
});

test("⑥b a tool task's prompt CAN still be edited to another JSON object", async () => {
  await boot();
  const job = await cron.addJob({ prompt: '{"query":"x"}', tool: "server::search", cron: "0 9 * * *" });
  const updated = await cron.updateJob(job.id, { prompt: '{"query":"y","limit":3}' });
  assert.equal(updated.prompt, '{"query":"y","limit":3}');
});

// ── ③ maxRuns 只对循环形态有意义 ────────────────────────────────────────────

test("⑦ REGRESSION: a one-shot task cannot be given a run cap", async () => {
  await boot();
  const when = new Date(Date.now() + 3_600_000).toISOString();
  const job = await cron.addJob({ prompt: "once", when });

  await assert.rejects(
    () => cron.updateJob(job.id, { maxRuns: 3 }),
    /recurring form/i,
    "a cap on a non-repeating task is a promise the engine can never keep",
  );
  assert.equal(engine.getRecord(job.id).maxRuns ?? null, null, "nothing is written when the edit is rejected");
});

test("⑦b a recurring task can be given a cap in place", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "recurring", cron: "0 9 * * *" });
  const updated = await cron.updateJob(job.id, { maxRuns: 2 });
  assert.equal(updated.maxRuns, 2);
  assert.equal(updated.runs ?? 0, 0);
});

// ── ④ delayMinutes 与 when 不许同时给出 ────────────────────────────────────

test("⑧ REGRESSION: delayMinutes and when together are rejected, not silently merged", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "conflict", cron: "0 9 * * *" });
  await assert.rejects(
    () => cron.updateJob(job.id, { delayMinutes: 30, when: new Date(Date.now() + 7_200_000).toISOString() }),
    /exclusive/i,
    "creation rejects this combination; the edit face must too",
  );
});

// ── ④⑤ 对照：本来就正确的路径 ──────────────────────────────────────────────

test("④ control: cron → interval still replaces the rule", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "switch-to-interval", cron: "0 9 * * *" });
  const updated = await cron.updateJob(job.id, { interval: { number: 6, unit: "hour" } });
  assert.equal(updated.cron ?? null, null, "the cron form is cleared");
  assert.ok(updated.interval, "the interval rule is stored");
  const h = hoursToNextRun(updated);
  assert.ok(h > 0 && h <= 6.1, `next run must follow the interval rule, got ${h.toFixed(1)}h away`);
});

test("⑤ control: a metadata-only edit leaves the armed occurrence alone", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "metadata-only", interval: { number: 3, unit: "day" } });
  const before = hoursToNextRun(engine.getRecord(job.id));
  const updated = await cron.updateJob(job.id, { prompt: "metadata-only (renamed)" });
  assert.ok(updated.interval, "the interval rule survives a prompt edit");
  const after = hoursToNextRun(updated);
  assert.ok(Math.abs(after - before) < 0.1, `the armed occurrence must not move (${before.toFixed(1)}h → ${after.toFixed(1)}h)`);
});
