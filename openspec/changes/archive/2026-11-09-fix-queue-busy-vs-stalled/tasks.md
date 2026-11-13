# Tasks — fix-queue-busy-vs-stalled

## 1. 判定

- [x] 1.1 `lastSettledAt`：`finishExecution` 每次收口写入（任何结局）
- [x] 1.2 `queueHealth.degraded = (queuedTooLong && !settledRecently) || overBudget > 0`，并在投影里带 `lastSettledAt`
- [x] 1.3 `initTaskEngine` 清零（新进程尚未收口）

## 2. 测试（`test-queue-health.mjs` 12 条，含新增 2 条）

- [x] 2.1 深积压 + 30 秒前刚收口 → `degraded=false`，投影带推进时刻
- [x] 2.2 深积压 + 窗口内无收口 → `degraded=true`（原事故仍可检测）
- [x] 2.3 原有 10 条全绿（含超预算降级、锚点、暂停不计数）
- [x] 2.4 反证：退回「排队久即降级」 → 2.1 红；还原 12/12 绿
- [x] 2.5 邻接：`test-task-engine`(29) / `queue-staleness`(6) / `queue-watchdog`(3) /
      `main-chain-priority`(4) / `fair-queue`(12) / `fair-queue-serial`(3) / `fleet-context-pressure`(12) 全绿

## 3. 规格

- [x] 3.1 `cell-execution-queue`：拥堵/停滞区分 + 3 场景

## 4. 上线

- [x] 4.1 快照 b4d3952 → GHA ✅ → relay → digest sha256:cb2bb468 → GitOps 4432698 → ArgoCD → 滚完 →
      **产线实证（同一镜像、同一时刻、同一 pod）**：积压 103 分钟但刚有收口的 cell → `ready=true`（`lastSettledAt` 有值）；
      积压 97 分钟且无收口的 cell → `ready=false`（`lastSettledAt=null`）；空队列 → 200。两态同时可观测
- [x] 4.2 归档（`openspec validate --strict` 通过后）
