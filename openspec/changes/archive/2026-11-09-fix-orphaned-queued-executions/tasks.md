# Tasks — fix-orphaned-queued-executions

## 1. 可检出

- [x] 1.1 `queueHealth()` 增 `orphaned` 计数（排队态但不在待取集合，且排除在途窗口）
- [x] 1.2 `orphaned > 0` 并入 `degraded`（否则孤悬永远静默）

## 2. 可自愈

- [x] 2.1 `enqueueExecution` 的 already 分支判定「是否真在链上」，不在则 `dispatch(id)` 补挂
- [x] 2.2 返回值带 `requeued: true` 供调用方区分「本来就在跑」与「刚被补挂」
- [x] 2.3 记录 `inFlightExecutionId`（drain 摘取 → 回合开跑之间的窗口），判定时排除

## 3. 验证

- [x] 3.1 `test-queue-staleness` **9/9**：新增「孤悬被重新挂链并真的开跑」用例
- [x] 3.2 `test-queue-health` **12/12**：既有「阈值内积压仍健康」在新语义下仍成立（在途窗口排除生效）
- [x] 3.3 相邻：watchdog 3/3、turn-events 15/15、boot-guard 2/2、cron-round-rotation 5/5
- [x] 3.4 `node --check` + biome 通过

## 4. 收口

- [x] 4.1 出片 + GitOps 滚版，产上确认
  - 镜像 `sha-ca1faea`（基线含他线 `7c7c0fc` 的重放排序修复，两者共存）；ccr relay OK 2026-11-09T17:55:36+08:00；
    GitOps `5da0707`。容器内实证 `inFlightExecutionId` 5 处、`orphaned` 字段 1 处、`firstQueuedAt` 14 处
    （我的孤悬自愈与他线的重放按真实等待顺序**同时在线**，未互顶）
  - 产上 `/api/ready`：`queued 2 / running 1 / orphaned 0 / pending 4 / degraded false`
    —— 新字段可读、队列在推进、无孤悬
