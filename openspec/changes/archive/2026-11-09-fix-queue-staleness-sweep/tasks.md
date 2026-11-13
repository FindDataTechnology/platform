# Tasks — fix-queue-staleness-sweep

## 1. 抽出共用判定

- [x] 1.1 `dropIfStaleQueued(t, nowMs)`：保留原有全部条件（`QUEUE_MAX_AGE_MS>0` / `trigger==="schedule"` / `queuedBy!=="human"` / 锚点超限），丢弃时清锚点与 `queuedBy` 并打日志
- [x] 1.2 出队路径改为调用该函数（行为不变）

## 2. 周期清扫

- [x] 2.1 `sweepStaleQueuedFires(nowMs)`：扫内存队列、返回丢弃数、有丢弃才落盘
- [x] 2.2 引擎初始化后起 60 秒 unref 定时器（`QUEUE_STALE_SWEEP_MS` 可配），异常只 warn 不抛
- [x] 2.3 `shutdown()` 清掉该定时器（不留悬挂计时器）

## 3. 验证

- [x] 3.1 `scripts/test-queue-staleness.mjs` **8/8**，新增两例：
  - 被长期插队的过龄 cadence 轮被清扫，且 `queueHealth().degraded` 由 true 恢复 false
  - 人工点火（`queuedBy: human`）与正在跑的轮永不被清扫
- [x] 3.2 相邻套件：`test-queue-watchdog` 3/3、`test-fleet-turn-events` 15/15、`test-queue-health` 10/10
- [x] 3.3 `node --check` + biome 通过（顺手修掉既有 `(other.history ||= [])` 的 noAssignInExpressions）

## 4. 收口

- [x] 4.1 出片 + GitOps 滚版，并在产上确认清扫生效、探针恢复
  - 出片 `sha-89f4ce3`（快照 60a6912ba）：relay OK 2026-11-09T13:26:33+08:00；GitOps `04aad49`；Argo 落地后
    容器内 `grep -c sweepStaleQueuedFires task-engine.js` = 2，且同时 `recordFleetTurnEvent` = 2（未顶掉他线 E21）
  - 产上复核：cell 1da519d4c1c0bf89 队列最老等待由 80.3 分钟降到 4.3 分钟，`/api/ready` 由
    `503 {"ready":false,…"degraded":true,"oldestQueuedMs":4597515}` 恢复为
    `200 {"ready":true,"dshInitError":null,…}`
