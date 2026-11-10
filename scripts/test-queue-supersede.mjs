#!/usr/bin/env node
// 同岗位排队顶替（openspec: harden-fleet-execution-economics 3.1）
//
// 默认关闭。开着时钉四条语义：
//   1. 同岗位新轮入队 → 尚未开始的旧轮标 superseded（不静默丢弃：进 history + 指向新轮）；
//   2. **只顶没开始的**：running 的绝不顶；
//   3. **人点的不顶**（queuedBy=human）；
//   4. 不同岗位 / 不同舰队不互相顶；岗位可 `noSupersede` 豁免。
//
//   node --test scripts/test-queue-supersede.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "queue-supersede-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const engine = await import("../task-engine.js");

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

async function freshEngine() {
  const init = () => engine.initTaskEngine({
    broadcast: () => {}, runTurn: () => new Promise(() => {}), isBusy: () => false,
  });
  await init();
  fs.rmSync(process.env.CRON_STORAGE_PATH, { recursive: true, force: true });
  await init();
}

function relay(fleetId, memberId, preset, prompt) {
  return engine.insertTask({
    id: `r_${Math.random().toString(36).slice(2, 9)}`,
    name: "relay", prompt, trigger: "manual", preset,
    sourceTag: { fleetId, memberId },
  });
}

// 直接构造状态，不跑真实执行：`executionQueue` 是模块级单例，前一个用例里
// "永不返回的回合"会把串行链永久占住，后续用例看到的状态就不是自己造的那个了。
// 这条纪律与 test-queue-staleness 一致（它也直接设 firstQueuedAt）。
function queue(id) {
  const rec = engine.getRecord(id);
  rec.state = "queued";
  rec.queuedAt = Date.now();
  rec.firstQueuedAt = Date.now();
  return rec;
}

// ── 默认关闭 ─────────────────────────────────────────────────────────
test("flag off: queued rounds for the same post are all kept", async () => {
  delete process.env.QUEUE_SUPERSEDE_MANUAL;
  await freshEngine();
  const a = relay("f1", "m1", "code", "round A");
  const b = relay("f1", "m1", "code", "round B");
  queue(a.id);
  engine.enqueueExecution(b.id);
  assert.notEqual(engine.getRecord(a.id).state, "skipped",
    "with the flag off nothing may be superseded");
});

// ── 开启：顶替 ───────────────────────────────────────────────────────
test("flag on: a newer round supersedes the older unstarted one", async () => {
  process.env.QUEUE_SUPERSEDE_MANUAL = "1";
  await freshEngine();
  const a = relay("f1", "m1", "code", "round A");
  const b = relay("f1", "m1", "code", "round B");
  queue(a.id);

  engine.enqueueExecution(b.id);

  const ra = engine.getRecord(a.id);
  assert.equal(ra.state, "skipped", "older unstarted round must be superseded");
  assert.equal(ra.supersededBy, b.id);
  const last = ra.history.at(-1);
  assert.equal(last.state, "skipped");
  assert.match(String(last.error), /superseded by/);
  delete process.env.QUEUE_SUPERSEDE_MANUAL;
});

test("a running round is never superseded", async () => {
  process.env.QUEUE_SUPERSEDE_MANUAL = "1";
  await freshEngine();
  const a = relay("f1", "m1", "code", "round A");
  engine.getRecord(a.id).state = "running";   // 正在跑
  const b = relay("f1", "m1", "code", "round B");
  engine.enqueueExecution(b.id);
  assert.equal(engine.getRecord(a.id).state, "running",
    "running work must survive a newer enqueue");
  delete process.env.QUEUE_SUPERSEDE_MANUAL;
});

test("human-requested rounds are never superseded", async () => {
  process.env.QUEUE_SUPERSEDE_MANUAL = "1";
  await freshEngine();
  const human = relay("f1", "m1", "code", "human asked for THIS round");
  const r = queue(human.id);
  r.queuedBy = "human";
  const later = relay("f1", "m1", "code", "later mechanical round");
  engine.enqueueExecution(later.id);
  assert.equal(engine.getRecord(human.id).state, "queued",
    "a round a human asked for must not be superseded");
  delete process.env.QUEUE_SUPERSEDE_MANUAL;
});

test("different posts and exempt posts are untouched", async () => {
  process.env.QUEUE_SUPERSEDE_MANUAL = "1";
  await freshEngine();
  const otherFleet = relay("f2", "m9", "code", "different fleet");
  const otherMember = relay("f1", "m2", "code", "different member");
  const exempt = engine.insertTask({
    id: "exempt1", name: "exempt", prompt: "exempt", trigger: "manual",
    preset: "code", sourceTag: { fleetId: "f1", memberId: "m1" }, noSupersede: true,
  });
  queue(otherFleet.id); queue(otherMember.id); queue(exempt.id);
  engine.getRecord(exempt.id).noSupersede = true;

  const newRound = relay("f1", "m1", "code", "newest");
  engine.enqueueExecution(newRound.id);

  assert.notEqual(engine.getRecord(otherFleet.id).state, "skipped", "different fleet must survive");
  assert.notEqual(engine.getRecord(otherMember.id).state, "skipped", "different member must survive");
  assert.notEqual(engine.getRecord(exempt.id).state, "skipped", "noSupersede must survive");
  delete process.env.QUEUE_SUPERSEDE_MANUAL;
});

// ── 3.3：被顶替/被降级要能在读面上看见 ────────────────────────────────
//
// 只报计数不报开关，会把"功能没开"读成"从来没发生过顶替"——产线
// `QUEUE_SUPERSEDE_MANUAL` 恰恰没设。所以这两个字段必须同时出现。

test("读面：开关关时 superseded=0 且 supersedeEnabled=false（零带原因）", async () => {
  delete process.env.QUEUE_SUPERSEDE_MANUAL;
  await freshEngine();
  const a = relay("f1", "m1", "code", "round A");
  const b = relay("f1", "m1", "code", "round B");
  queue(a.id);
  engine.enqueueExecution(b.id);

  const h = engine.queueHealth();
  assert.equal(h.superseded, 0, "关着的时候不可能有顶替");
  assert.equal(h.supersedeEnabled, false,
    "必须把开关报出来，否则 0 会被误读成「没发生过」");
});

test("读面：开关开时 superseded 计数可见，且与 history 的 kind 对得上", async () => {
  process.env.QUEUE_SUPERSEDE_MANUAL = "1";
  await freshEngine();
  const a = relay("f1", "m1", "code", "round A");
  const b = relay("f1", "m1", "code", "round B");
  queue(a.id);
  engine.enqueueExecution(b.id);

  const ra = engine.getRecord(a.id);
  assert.equal(ra.state, "skipped");

  const h = engine.queueHealth();
  assert.equal(h.supersedeEnabled, true);
  assert.ok(h.superseded >= 1, `读面必须数得到被顶替的轮次，实际 ${h.superseded}`);

  // 两个面必须一致：jobs.json 里的 history 行 与 /api/ready 的计数
  const histKinds = (ra.history || []).filter((x) => x.kind === "superseded");
  assert.equal(histKinds.length, 1, "history 里恰有一条 kind:superseded");
  assert.equal(histKinds[0].supersededBy, b.id);
  delete process.env.QUEUE_SUPERSEDE_MANUAL;
});
