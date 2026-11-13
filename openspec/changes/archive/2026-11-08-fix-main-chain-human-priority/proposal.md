# Proposal — fix-main-chain-human-priority

## Why

主槽（primary slot）是**一条串行链**：产线 `TASK_WORKER_MAX=0`，worker 池惰性不注册，
所有执行——节奏 fire、扇出目标、主人点的「立即执行」——都排在同一条链上（explore P2-5）。

`humanPriority` 这个标记**只有 worker 池认**（`worker-slots.js` 的额外槽），而产线上池压根没开：

```js
// server/routes/fleets.js — 主人的「立即执行」确实打了标记
humanPriority: true, // the owner's execute-now IS the human wake (worker pool's extra slot)
```

於是这条车道的承诺在产线上是空的：主人亲手按下的一轮，排在整条积压后面。实测
（2026-11-08，`fix-cell-turn-throughput` 的记录）：`run now` 在 18 条排队后干等 180s。
`firstQueuedAt` 的陈旧淘汰只丢「超过 30 分钟没人要的节奏 fire」，30 分钟以内的积压照排——
人的那一轮仍要在它们后面。

## What Changes

- 主槽串行链改为**出队时选序**：执行不再入队即挂到 promise 尾部（挂上就再也无法重排），
  而是先进一个待执行列表，链上只挂「下一个真正要跑的」。
- 选序规则：已打 `humanPriority` 的执行 SHALL 越过**尚未开始**的执行；同类之间按到达顺序；
  绝不抢占**正在跑**的那一条（串行语义不变）。
- `idle()` 同步跟进：它现在要等待执行列表清空，而不只是等 promise 尾部。
- 不动 worker 池的额外槽规则（池开着时仍按原规则，产线不涉及）；不动陈旧淘汰、看门狗、
  重试或成交/送达语义。

## Impact

- Affected specs: `task-engine`（MODIFIED：执行槽排序，加 3 个场景）、
  `worker-pool`（MODIFIED：cap 0 休眠的措辞——优先级从此由主槽承担，不再「逐字节一致」）
- Affected code: `task-engine.js`（`pendingExecutions` + `drainExecutions`，`chainExecution` 与 `idle()`）
- 无迁移、无新表、无新 env；产线配置（`TASK_WORKER_MAX=0`）不变。
- 行为变化仅限「有 humanPriority 执行在排队」时的顺序，其余路径逐条不变。
