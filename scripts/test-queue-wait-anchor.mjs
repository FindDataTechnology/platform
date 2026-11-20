// queue_wait_ms 必须量"真实等待"，不是"本次尝试的等待"。
//
// 为什么单独钉：`job.queuedAt` 在每次重新入队和每次启动 drain 时都会被重打
// （task-engine.js 的设计，用于"本轮排队多久"）。用它当 queue_wait_ms 的起点，
// 重启后所有积压的 fire 都会显示成刚刚入队——而 queue_wait_ms_max 正是
// fleet-cost-digest 用来提议「要不要加并发」的那个数，也就是最需要准的时候最不准。
import assert from "node:assert/strict";
import { _queueWaitMs } from "../server/cron-runner.js";

// 1. firstQueuedAt 优先：本次尝试 1 分钟，但真实等待 10 分钟
{
  const now = 1_000_000;
  const job = { queuedAt: now - 60_000, firstQueuedAt: now - 600_000 };
  assert.equal(_queueWaitMs(job, now), 600_000, "must measure from firstQueuedAt");
}

// 2. 无 firstQueuedAt（旧记录）回落 queuedAt，不能返回 null
{
  const now = 1_000_000;
  assert.equal(_queueWaitMs({ queuedAt: now - 5_000 }, now), 5_000);
}

// 3. 两者都缺 → null（不猜 0）
assert.equal(_queueWaitMs({}, 1_000_000), null);

// 4. 时钟倒挂（dequeue 早于 anchor）不得出现负数
{
  const now = 1_000_000;
  assert.equal(_queueWaitMs({ firstQueuedAt: now + 5_000 }, now), 0);
}

// 5. 非数值 anchor 视为缺失
assert.equal(_queueWaitMs({ queuedAt: "oops" }, 1_000_000), null);

console.log("queue-wait-anchor: all assertions passed");
