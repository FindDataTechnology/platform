# Tasks — fix-main-chain-human-priority

## 1. 主槽选序（`task-engine.js`）

- [x] 1.1 `pendingExecutions` + `executionDraining`：待执行列表与「链上已有本队列执行」标志
- [x] 1.2 `chainExecution(id)` 改为入列表 + `drainExecutions()`（不再入队即挂 promise 尾）
- [x] 1.3 `drainExecutions()`：优先取第一条 `humanPriority`，否则取队首；一次只挂一条；
      成功与失败都继续 drain（失败不得卡死整链）
- [x] 1.4 `idle()` 等待列表清空而不只是 promise 尾（含给 drain 一个 microtask 的窗口）

## 2. 测试（`scripts/test-main-chain-priority.mjs`，4 条）

- [x] 2.1 人优先越过未开始的积压：`A, H, B, C`，且 `maxConcurrent === 1`
- [x] 2.2 人优先之间保持到达顺序；普通执行不越过更早的人唤醒
- [x] 2.3 无人唤醒时纯 FIFO（无回归）
- [x] 2.4 `idle()` 在仍有待执行条目时不返回，清空后返回且状态为 done
- [x] 2.5 反证：恢复「入队即挂尾」旧实现 → 2.1 在 13ms 内红（顺序断言失败），装回后 4/4 绿
- [x] 2.6 邻接：`test-worker-pool`(8) / `test-task-engine`(29) / `test-queue-*`(16) /
      `test-cron-catchup`(9) / 六个 fleet 套件 + `test-task-retry-policy`(9) / `test-ready-queue-and-run-honesty`(6) 全绿

## 3. 规格

- [x] 3.1 `task-engine`：MODIFIED 执行槽排序（人优先越过未开始 + 3 个场景）
- [x] 3.2 `worker-pool`：MODIFIED cap 0 休眠措辞（池不注册；优先级由主槽承担）

## 4. 上线

- [x] 4.1 快照 e58cf30 → GHA image ✅ → relay OK 6s → skopeo digest `sha256:6aa06398` → GitOps f244fe5 →
      ArgoCD Synced → platform/facet 滚完 → **舱内跑本套件 4/4 绿**（`TASK_WORKER_MAX=0` 实测）
- [x] 4.2 归档（`openspec validate --strict` 通过后）
