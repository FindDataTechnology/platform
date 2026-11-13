# Design — fix-pool-waiting-is-not-an-orphan

## Context

现象、根因与实验证据见 proposal.md。本文件只记两件事：为什么是"抽谓词"而不是"再内联一行"，以及 `claims` 的生命周期边界。

现状（远端 tip `1c003d38b` 读码）：

| 事实 | 位置 |
|---|---|
| 池维护 `claimed` Set，暴露 `dispatcher.claims(id)` | `server/worker-slots.js:515` |
| 周期清扫已接：`if (slotDispatcherFn?.claims?.(t.id)) continue;` | `task-engine.js:1135` |
| 就绪面孤儿计数**未接**，只认 `pendingExecutions` + `inFlightExecutionId` | `task-engine.js:1904-1911` |
| `degraded = stalled \|\| overBudget > 0 \|\| orphaned > 0` | 同文件 `queueHealth` |

实验（同 tip，非推断）：cap=1 + 两 persona 构造 → `h1.orphaned=0, h2.orphaned=1, h2.degraded=true`。

## Goals / Non-Goals

**Goals**

- 让就绪面与清扫对"什么算在链上"给出同一个答案。
- 消除"改了一处、漏了另一处"的结构性诱因。

**Non-Goals**

- 不改池的认领/排序/容量语义（`1c003d38b` 已完成该部分）。
- 不改真孤儿的自愈行为。

## Decisions

### D1. 抽 `isOnChain(t)`，两处都调它

本次事故的形状值得单独记：**同一个事实有两个读点（1135 行与 1904 行），改动只落在其中一个**。这不是疏忽，是结构——两处各自内联一份 `pendingExecutions` 判定，没有任何机制约束它们一致。

所以修法不是"在 1904 行也加一行 `claims`"，而是抽一个谓词，两个调用点都改成调它。理由与今天在 `oldestQueuedMs` / `queuedExempt` 上的结论同源：**同一事实只能有一个权威判定**。

**替代方案**：在 `queueHealth` 里内联 `slotDispatcherFn?.claims?.(t.id)`。否决——那会让第三次（未来新增远程执行器持有）继续漏，而且这次事故就是这么发生的。

### D2. `claims` 只覆盖"已认领未开始"，这是正确的边界

`claimed` 在 `runTaskOn` 启动时被清除（`1c003d38b` 实现）。所以：

- 认领后、启动前 → `claims` 为真 → 算在链上 ✅
- 启动后 → 由 `inFlightExecutionId` 或 `state=running` 覆盖 ✅
- 跑完后 → `state` 已变，不再是 `queued` ✅

三段首尾相接，没有空档。**不需要额外的状态字段**，也不需要把 `waiting` 整个搬进引擎——那条路会污染 `fairness`/`oldestQueuedMs` 的语义（它们按 `pendingExecutions` 计）。

### D3. 谓词保持"未知即不在链上"的保守方向

`claims` 是可选注入（`slotDispatcherFn?.claims?.(...)`）。注入缺失时返回 undefined → 判为不在链上 → 真孤儿照旧自愈。方向正确：**宁可多救一次，不可静默停住**。

## Risks / Trade-offs

- **[风险] 池崩溃后 `claimed` 残留，导致真孤儿被误判为"正常等待"而永远不重派** → 缓解：`claimed` 的条目在 `runTaskOn` 启动时清除，池整体失活时引擎侧 `slotDispatcherFn` 一并失效（`setSlotDispatcher(null)`），谓词自然退回两态。实施时需确认池的关闭路径确实调用了 `setSlotDispatcher(null)`，并把这条写进测试。
- **[风险] snake_case `claims` 与 `dispatcher` 结构耦合** → 可接受：两者同属一个对象，且已有 `runOnPrimary` 的同类契约。
- **[风险] 就绪面从"恒红"变为"如实"，可能暴露此前被掩盖的真孤儿** → 这是期望行为；若上线后 `orphaned` 仍频繁为真，说明池外确有真孤儿，应据此另开单排查，而不是把判据再放宽一次。

## Migration Plan

- 无配置变更、无停机、无数据迁移。
- 回滚：谓词改回内联两态即复原（一行）。
- 上线后观察：池有等待时 `/readyz` 的 `degradedCells` 应不再恒真；同一批 id 的重复日志应已消失（`1c003d38b` 生效后）。

## Open Questions

（无。实现路径已定；剩余是测试与出片。）
