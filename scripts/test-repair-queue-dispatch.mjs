#!/usr/bin/env node
// ── 重放派发：restart 之后重跑的是「同一份工作」，必须走同一个派发缝 ──────────
//
// fix-fleet-replay-dispatch-and-turn-accounting 1.1 / 1.2。
//
// `drainRepairQueue()` 恢复的是「上次进程死时还在排队」的触发。它曾经调
// `chainExecution()`——那是**串行链专用**的入口，绕过了 `dispatch()` 的池认领。
// 线上后果（2026-11-08）：cell 配了 `TASK_WORKER_MAX=2`、日志写着 `worker-pool active`，
// 却一个 worker 都没 spawn，而 17+ 个重放任务排在**新触发前面**，新触发随后被
// `QUEUE_MAX_AGE_MS` 老化**丢弃**（不是延迟）。也就是说：重启之后那段时间，池等于不存在。
//
// 两条判据方向相反，缺一条都证明不了「同权」：
//   A. 池**配了** ⇒ 重放必须先问池；池认领后**不得**再被串行链跑（否则双跑）。
//   B. 池**没配** ⇒ 行为与改动前逐字节一致：串行链接手，任务真的跑完。
//
// 驱动方式刻意用**持久化记录**而不是内存插入：`repairQueue` 是 `loadTasks()` 在
// 载入时按 `state === "queued"` 建起来的，内存插入根本进不了这条缝（那是 1.2 之前
// 这条缺陷一直没被测试覆盖的原因——测的都是 `enqueueExecution` 那条路）。
//
//   node --test scripts/test-repair-queue-dispatch.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = fs.mkdtempSync(path.join(os.tmpdir(), "repair-dispatch-"));
process.env.CRON_STORAGE_PATH = store;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一次「上次进程死时还在排队」的任务。时间戳取现在：`firstQueuedAt` 若写成远古
// 时刻，sweep 会先把它当老化丢掉，两条用例就都测不到派发缝了。
const queuedAt = Date.now();
fs.writeFileSync(
  path.join(store, "jobs.json"),
  JSON.stringify([
    {
      id: "replay-1",
      trigger: "schedule",
      prompt: "p",
      targetType: "persona",
      state: "queued",
      sessionId: "cron-replay-1",
      firstQueuedAt: queuedAt,
      queuedAt,
    },
  ]),
);

const engine = await import(path.join(here, "../task-engine.js"));

async function boot(started) {
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: (task) => { started.push(task.id); return Promise.resolve({ ok: true }); },
    isBusy: () => false,
    resolveTurnBudget: () => 50,
  });
}

async function waitFor(predicate, { timeoutMs = 4000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

test("A. 池配了：重放先问池，认领后不再进串行链（1.1 的缺陷面）", async () => {
  const started = [];
  await boot(started);
  const claims = [];
  engine.setSlotDispatcher((task) => {
    claims.push(task?.id ?? null);
    return true; // 「池接了」——按 dispatcher 的契约，true 表示这次派发归池
  });

  engine.drainRepairQueue();

  assert.deepEqual(claims, ["replay-1"],
    "重放必须走 dispatch()：不问池就说明它回到了 chainExecution（这正是 1.1 修的缺陷）");
  await sleep(80);
  assert.deepEqual(started, [],
    "池认领之后串行链不得再跑同一份工作（双跑会让同一轮落两行账）");
  // 池接了但还没开跑 ⇒ 任务仍在 queued（认领 ≠ 执行），这是 worker 车道的正常中间态
  assert.equal(engine.getRecord("replay-1").state, "queued");
});

test("B. 没配池：与改动前逐字节一致——串行链接手并真跑完", async () => {
  engine.setSlotDispatcher(null);
  const started = [];
  await boot(started);
  engine.drainRepairQueue();

  const ran = await waitFor(() => started.includes("replay-1"));
  assert.equal(ran, true, "没有池时重放仍必须落在串行链上跑掉（不许丢）");
  const settled = await waitFor(() => engine.getRecord("replay-1").state === "done");
  assert.equal(settled, true, "跑完之后状态要正常落 done");
});

test("C. 盘上没有 `history` 键的老记录也能重放（否则静默卡在 running）", async () => {
  // 2026-11-16 实测到的真形态：`loadTasks` 只补 trigger/targetType/sessionId/state，
  // **不补 `history`**；而 `getTask()` 里有 `t.history.slice(-20)`，它被
  // `broadcastStatus()` 在 `t.state = "running"` 之后、`await turnFn(...)` 之前调用。
  // 于是老记录的重放：状态永远 `running`、回合一次都没开始、`chainExecution` 的
  // `.then(done, done)` 把 TypeError 吞掉 —— 日志、退出码、/api/ready 全无痕迹。
  // 这条用例的夹具**故意不写 history**：它描述的是「盘上比自己更老的记录」，
  // 而那正是 restart 后重放唯一会遇到的形态。
  const legacy = {
    id: "replay-legacy",
    trigger: "schedule",
    prompt: "p",
    targetType: "persona",
    state: "queued",
    sessionId: "cron-replay-legacy",
    firstQueuedAt: Date.now(),
    queuedAt: Date.now(),
    // ← 没有 history
  };
  const current = JSON.parse(fs.readFileSync(path.join(store, "jobs.json"), "utf8"));
  fs.writeFileSync(path.join(store, "jobs.json"), JSON.stringify([...current, legacy]));

  const started = [];
  await boot(started);
  engine.drainRepairQueue();

  const ran = await waitFor(() => started.includes("replay-legacy"));
  assert.equal(ran, true,
    "缺 history 的老记录必须照样被重放（卡在 running 就是这个缺陷的指纹）");
  const settled = await waitFor(() => engine.getRecord("replay-legacy").state === "done");
  assert.equal(settled, true, "跑完之后状态要正常落 done，而不是永远 running");
});
