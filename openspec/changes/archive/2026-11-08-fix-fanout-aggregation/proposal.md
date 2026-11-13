# Proposal — fix-fanout-aggregation

## Why

扇出后的"汇总回合"有两处与规格不符，都是**声明了但没兑现**：

1. **无 judge 的扇出丢了 initiator 人格**（D1）。`server/fleet-handoffs.js` 的扇出分支
   只在 judge 分支传 `initiatorPreset`，无 judge 分支只传 `initiator`。聚合器收口时
   `reanchorInitiatorPersona(ctx, initiator, group[0].initiatorPreset)` 因此拿到
   `undefined` 直接 return——而它自己的注释写着为什么不能省：「a dormant one would resume
   the runtime default (**the last fan-out target's persona**), so the park re-anchors it」。
   净效果：主编扇出给撰稿 A/B，汇总回合是**以撰稿 B 的人格**说的。
   规格原文写的是「把全组结果注入**上游岗**的下一回合」，不是"以某个靶岗口吻"。

2. **分组没有波次/run 维度**（D2）。`server/delegation-aggregator.js` 的
   `groupFor(initiator)` 只按 `initiator` 过滤。同一个上游岗第二次扇出（或裁决者发起的
   第二轮辩论）与第一波用同一个 initiator → **两波并成一组**：一次汇总覆盖两波产出，
   且整组继承 `group[0].initiatorPreset`（第一波的人格）。`origin.fleet.wave` 字段
   恒为字面量 1、从没人读过，所以现成字段也当不了分组键。

两处都不是新愿望：`agent-delegation-tools`「Finished fan-outs inject an aggregation turn」
与 `agent-fleet-orchestration`「fanout 边以并行波执行」都已经把"每一波/每次聚合"
当成单位，实现却按会话聚合。

## What Changes

- **扇出每次点火一个分组键**：`igniteFleetEdges` 的每条 fanout 边在点火时生成
  `fanout:<base36 时间>:<随机>`，随任务持久化到新字段 `initiatorGroup`；
  judge/非 judge 都带。
- **聚合器按分组键聚合**：`aggregationKey(task) = task.initiatorGroup ?? task.initiator`。
  没有键的老任务与 web 车道的 delegate 工具（本来就是"一次会话一轮"）行为**逐字节不变**。
- **无 judge 的扇出补上 `initiatorPreset: job.preset`**：上游回合实际所用的人格。
  web 车道的 `delegate` 早就是这么写的（`delegation.js` 的 `initiatorPreset: current`），
  本次只是让扇出同一纪律。
- **不做**：不重定义 `origin.fleet.wave` 的语义（它是溯源信息，不是分组键；真正的
  波次区分靠点火键），不给 web 车道引入分组键（那里"一会话一轮"就是正确粒度）。

## Impact

- Affected specs: `agent-delegation-tools`（1 个 requirement 修订）、
  `agent-fleet-orchestration`（1 个 requirement 修订）
- Affected code: `task-engine.js`（新字段 + 持久化）、`server/delegation-aggregator.js`
  （分组键）、`server/fleet-handoffs.js`（点火键 + initiatorPreset）
- 无迁移：老任务无 `initiatorGroup`，`aggregationKey` 回落到 `initiator` 即旧行为。
