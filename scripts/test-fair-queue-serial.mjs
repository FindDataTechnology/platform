#!/usr/bin/env node
// ── Fair queue keeps the serial + watchdog contract (split-meta-team-queue-capacity 4.1-4.3) ──
//
// The fairness change only reorders WHICH pending execution runs next. It must
// never introduce concurrency or bypass the watchdog: task-queue-liveness
// (archived 2026-11-08) owns "one turn at a time, bounded settlement, head of
// queue always advances". This suite boots the live engine with the fair policy
// ON and asserts those contracts still hold.
//
//   node --test scripts/test-fair-queue-serial.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Isolate storage BEFORE the dynamic import — otherwise the suite would read and
// rewrite the developer machine's real cron store.
process.env.CRON_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "fair-serial-"));
process.env.FLEET_FAIR_QUEUE = "1"; // the whole suite runs with fairness on

const engine = await import(path.join(here, "../task-engine.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Swappable turn body: each test installs the one it needs.
let turnBody = async () => ({ ok: true, text: "ok" });
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: (task) => turnBody(task),
  isBusy: () => false,
  resolveTurnBudget: () => 5_000,
});

const spans = [];
function addTask(id, fleetId) {
  engine.insertTask({
    id,
    name: id,
    prompt: "p",
    trigger: "manual",
    targetType: "persona",
    sourceTag: fleetId ? { fleetId, memberId: `m-${fleetId}` } : null,
  });
  return id;
}

async function waitFor(predicate, { timeoutMs = 8000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

test("4.1 多舰队排队时仍是严格串行：执行区间不重叠", async () => {
  spans.length = 0;
  turnBody = async (task) => {
    const startedAt = Date.now();
    await sleep(15);
    spans.push({ id: task.id, startedAt, endedAt: Date.now() });
    return { ok: true, text: "ok" };
  };
  const ids = [addTask("a1", "A"), addTask("a2", "A"), addTask("b1", "B"), addTask("c1", "C")];
  for (const id of ids) engine.enqueueExecution(id);
  await engine.idle();

  assert.equal(spans.length, 4, "四个任务都应执行");
  const sorted = [...spans].sort((x, y) => x.startedAt - y.startedAt);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(
      sorted[i].startedAt >= sorted[i - 1].endedAt,
      `执行 ${sorted[i - 1].id} 与 ${sorted[i].id} 重叠了 — 公平派发不得引入并发`,
    );
  }
});

test("4.3 同一任务重复点火仍回传 already（公平模式下语义不变）", async () => {
  turnBody = async () => ({ ok: true, text: "ok" });
  const id = addTask("dup", "A");
  const first = engine.enqueueExecution(id);
  const second = engine.enqueueExecution(id);
  assert.equal(first.ok, true);
  assert.equal(second.already, true, "重复入队必须如实回传 already:true");
  await engine.idle();
});

test("4.2 看门狗在公平模式下仍结算超预算回合并释放队头", async () => {
  const saved = process.env.QUEUE_WATCHDOG_MS;
  process.env.QUEUE_WATCHDOG_MS = "60";
  try {
    turnBody = (task) =>
      task.id === "stuck" ? new Promise(() => {}) : Promise.resolve({ ok: true, text: "ok" });
    const stuck = addTask("stuck", "A");
    const behind = addTask("behind", "B");
    engine.enqueueExecution(stuck);
    engine.enqueueExecution(behind);

    const settled = await waitFor(() => engine.getRecord(stuck)?.state === "failed");
    assert.ok(settled, "超过看门狗界限的回合必须以失败结算");
    assert.match(String(engine.getRecord(stuck)?.error || ""), /watchdog/);

    const advanced = await waitFor(() => engine.getRecord(behind)?.state === "done");
    assert.ok(advanced, "队头释放后后续任务必须执行");
  } finally {
    if (saved === undefined) delete process.env.QUEUE_WATCHDOG_MS;
    else process.env.QUEUE_WATCHDOG_MS = saved;
  }
});
