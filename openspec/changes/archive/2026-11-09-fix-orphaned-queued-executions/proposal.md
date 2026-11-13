# Proposal — fix-orphaned-queued-executions

## Why

任务可以带着 `state = "queued"` 却**不在串行链上**（`pendingExecutions` 里没有它的执行）。
这时 `drainExecutions()` 无事可做，`running` 永远是 0，`lastSettledAt` 冻结，**队列永久停摆且不报任何错**。

更糟的是它无法自愈：`enqueueExecution` 的 "already queued" 分支无条件返回
`{ok:true, already:true}`，于是每一次新的点火都被这个分支吸收，谁也不会去补挂链。

生产实况（2026-11-09，cell 1da519d4c1c0bf89）：

```
queue.queued = 4     queue.running = 0     fairness pending = 0     持续约 20 分钟
run now → {ok: true, already: true, queuedForMs: 1266713}
```

排期轮从 16 分钟前一直"排队"，没有任何 `turn timed out` / `budget_exhausted` / `runtime not ready`；
唯一异常只有探针把「排队 16 分钟」报成 degraded。**人看到的是"忙"，实际是"死"。**

## What Changes

- **把「已排队」的语义收紧为「已在链上」**：`enqueueExecution` 的 already 分支先判定该任务是否真在
  链上（`running`，或确实持有 pending 执行 / 正在被摘取开跑），不在则 `dispatch(id)` 补挂，并在
  返回值里带 `requeued: true` 让调用方可辨。
- **在途窗口不算孤悬**：`drainExecutions` 把执行从 pending splice 出去之后、回合自己翻状态之前，
  任务仍读作 queued；记录 `inFlightExecutionId` 把这一个窗口排除在判定之外（否则每次正常调度都会被
  误判成孤悬）。
- **探针必须说出来**：`queueHealth()` 新增 `orphaned` 计数，并把它并入 `degraded`——孤悬任务
  永远不会跑，没有任何错误面，只能由健康面点破。

## 非目标

- 不改就绪等待、预算门、陈旧度与清扫（分属既有 change）。
- 不猜测孤悬的**成因**：本变更只保证「可检出 + 可自愈」，成因待复现后再定位。

## 验证

- `scripts/test-queue-staleness.mjs` **9/9**（新增：孤悬任务被重新挂链并真的跑起来，
  探针 meanwhile 报 orphaned/degraded）
- 相邻：`test-queue-health` **12/12**（其"阈值内积压仍健康"的夹具在新语义下依旧成立——
  在途窗口已排除）、`test-queue-watchdog` 3/3、`test-fleet-turn-events` 15/15、
  `test-task-engine-boot-guard` 2/2、`test-cron-round-rotation` 5/5
