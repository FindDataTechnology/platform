# Proposal — fix-queue-busy-vs-stalled

## Why

`/api/ready` 的队列健康判据（`fix-task-queue-deadlock` 引入）是：**最老等待 > 10 分钟即 `degraded`**，
而 `degraded` 会把整个 cell 的 readiness 打成 **503**。

今天（2026-11-09）产线实测：舰队 cell 的最老等待长期在 **60–67 分钟**，而同期**每 4–5 分钟就有一个回合成功收口**
（`04:31 ok`、`04:36 ok`、`04:41 ok`、`04:43 ok`）。队列明明在推进，探针却持续答 503。

原因是这条判据只量「等了多久」，不量「有没有在动」。舰队场景下（一条串行槽 + 每岗一条节奏任务）深积压是**常态**，
于是这个 cell 的 readiness 永久是红的——**把一个繁忙的 cell 报成不可用**，与它本来要抓的死锁长得一样。

## What Changes

- 引擎记录**最近一次执行收口时刻**（任何结局都算：失败的回合同样让出了槽）。
- `queueHealth.degraded` 改为 **`(最老等待超阈 && 窗口内无任何收口) || 超预算回合 > 0`**：
  - 「忙」= 积压深但在推进 → 不降级；
  - 「卡」= 积压深且完全不动 → 仍降级（原事故的可检测性不变）；
  - 超预算回合**无条件**降级（两种状态下都是错的）。
- 引擎重新初始化时清零推进时刻（新进程尚未收口任何执行）。

## Impact

- Affected specs: `cell-execution-queue`（+3 场景）
- Affected code: `task-engine.js`（`lastSettledAt`、`queueHealth` 判定、init 清零）
- 无迁移、无新 env；`/api/ready` 的响应形状只增一个 `lastSettledAt` 字段。
- 行为变化仅在「积压深但仍在推进」这一形态：从 503 变 200。真正的停滞仍 503。
