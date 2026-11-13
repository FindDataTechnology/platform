## Why

产线上正在发生的故障，其中一个半已修、半个还没修。

**实测（2026-11-09 23:10–23:40，`/readyz` 与 cell 日志）**：

```
ready=false  cells=3  answered=3  queued=4
oldestQueuedMs = 2,649,140（44 分钟，仍在涨）
degradedCells = ["3fdc7b8e8ac03b68"]
日志：同一批 id 每 30–60 秒重复一遍
  [task-engine] <id> is queued but off the chain — re-dispatching (sweep)
  [task-engine] queue health: 4 orphaned queued execution(s): ...
同期：[worker-pool] spawned worker-5 / reaped worker-1（池是活的，不是没槽）
```

**根因**：并发池认领任务后把 id 放进自己的 `waiting` 并对引擎返回 `true`，引擎于是不放进 `pendingExecutions`；而引擎有两处判定「在不在链上」，都只认 `pendingExecutions` + `inFlightExecutionId`。

| 调用点 | 位置 | 现状 |
|---|---|---|
| 周期清扫重派 | `sweepStaleQueuedFires()` | **已修**（`1c003d38b`，`slotDispatcherFn?.claims?.(t.id)` 跳过） |
| 就绪面孤儿计数 | `queueHealth()` 的 `orphaned` | **未修**——池等待仍被计入 |

**实验证据（在远端 tip `1c003d38b` 上跑，非推断）**：

```
构造：TASK_WORKER_MAX=1，A(persona=code) 占住唯一槽；B(persona=intel) 被池认领但无槽
B state: queued
h1  orphaned: 0  degraded: false     ← 孤儿去抖的第一拍
h2  orphaned: 1  degraded: true      ← 第二拍确认
```

`degraded = stalled || overBudget > 0 || orphaned > 0`，所以**只要池里有任务等槽，就绪面就恒 503**。sweep 的重复日志会消失，但 `/readyz` 仍然红——把「真的坏了」和「正常等待槽位」继续混成一个信号。

## What Changes

- `queueHealth()` 的孤儿判定 SHALL 复用与周期清扫**同一套认领语义**：池已认领（`dispatcher.claims(id)` 为真）的任务 MUST NOT 计入 `orphaned`，MUST NOT 使 `degraded` 为真。
- 两处判定 SHALL 共用同一个谓词，MUST NOT 各自内联一份——本次事故的成因正是"同一事实有两个读点，只改了一个"。
- 真孤儿 SHALL 仍被计入并重派（既有自愈行为逐字节不变）。
- 池未注册（cap 0）时行为 SHALL 与变更前一致。

**BREAKING**：无。这是把"合法等待"从"故障"里摘出来，不改变任何调度语义。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `cell-execution-queue`: 孤儿判定新增"被并发池持有"这一合法持有状态，并要求与周期清扫共用同一谓词。

## Impact

- **代码**：`task-engine.js`（`queueHealth` 的 `orphaned` 计算；建议同时抽一个 `isOnChain(t)` 供两处共用）。
- **可观测面**：`/readyz` 与 cell 侧 `/api/ready` 的 `degraded` 不再因池等待恒真；`orphaned` 恢复"真的坏了"的含义。
- **测试**：`scripts/test-queue-health.mjs` 增用例（池认领的任务不计 orphaned），并复用 `test-worker-pool.mjs` 里 `1c003d38b` 已建的 fake dispatcher 夹具。
- **运维**：无需配置变更、无需停机。
- **与既有单的关系**：`fix-operator-ignition-priority` 讨论池内**排序**；本单修的是"池等待不该被算成故障"。本单独立且应先行。
