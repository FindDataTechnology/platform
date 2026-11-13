# Design — fix-fanout-aggregation

## D1 无 judge 的扇出必须带上游岗的人格

`reanchorInitiatorPersona` 是**汇总回合的嗓音**：它把 initiator 会话的 persona 摆回
发起者的那一岗，因为扇出把这些会话留在了"最后一个靶岗"上。它开头就是
`if (!wanted || …) return;`——`wanted` 为空就静默跳过，汇总照发，但说话的人不对。

web 车道的 `delegate` 早就传了（`initiatorPreset: current ?? null`），扇出没传，
纯属两条车道写岔了。修法是把 `job.preset`（上游回合**实际所用**的人格，`runCronJobTurn`
一路带下来）传进任务记录。

**为什么不从 `memberId` 反查**：`db.getMember(memberId).targetId` 也能算出租户预设，
但那是**当下**的配置；`job.preset` 是这一回合真正跑的人格。回合结束后岗位被换防
（ADR-0031 restaff）时，两者会不同，而汇总要延续的是"刚才那个说话的人"。故用 `job.preset`，
取不到（老调用点/测试）就落 `null` —— 与改动前同行为，不引入新的失败面。

## D2 分组键：为什么是点火键，不是 runId/wave

三个候选都验过：

- **`origin.fleet.wave`**：`fleet-handoffs.js` 里恒为字面量 `1`，且从没有人读。
  第二波辩论是裁决者的 `dispatch_post` 发起的，根本不写 wave。拿它做键 = 所有波都同一组。
- **`chain.runId`**：只在 `chainFor` 能查到上游在飞回合时才有。`igniteFleetEdges` 的
  测试与无 ledger 部署下为 `null`，又退化成按会话聚合。
- **点火键**：`fanout:<base36 时间>:<随机>`，在每条扇出边点火前生成一次、整波共用。
  永远存在、永远唯一、随任务持久化（重启后仍能正确分组）。选它。

键存在新字段 `initiatorGroup` 而不是塞进 `origin.fleet`：`origin` 是**溯源**
（谁派的、怎么派的、链位多少），聚合分组是**投递语义**。混在一起会让 `origin`
的读面（runs/trace 展示）出现一个只对聚合器有意义的键。

## D3 回落即兼容

`aggregationKey(task) = task.initiatorGroup ?? task.initiator`。

- 老任务（升级前入队、重启后恢复）：无 `initiatorGroup` → 按 `initiator` 分组 = **旧行为**。
- web 车道的 `delegate` 工具：不传键 → 按会话分组 = **旧行为**（那里"一次会话一轮"是正确粒度，
  重叠轮次在同一会话里本来就互斥）。
- 扇出：有键 → 每波一组。

`runInjection(key)` 内部的会话仍从 `group[0].initiator` 取（一组任务共享同一 initiator），
键只用于"哪些任务算一组"，不用于寻址会话——两者不能混用（键不是 sessionId）。

## R1–R4

- **R1 双重汇总**：`pendingInjection` 现在按**键**去重（原按 initiator），两个键并发注入互不阻塞；
  同一键仍是单飞。`aggregated` 标记仍先落库再起回合。
- **R2 重启重臂**：`rearmPending` 收集的是键集合，老记录走 `initiator` 回落，行为不变。
- **R3 持久化遗漏**：`saveTasks` 是白名单式序列化，新字段必须显式加进去，否则重启即丢
  → 已加，并由测试守住（测试通过 `getTaskRecord` 读回）。
- **R4 judge 车道**：judge 的 initiator 是 `fleet:<fid>:<jid>`（合成值，不是会话），
  分组键对它同样必要——两轮裁决否则并成一组。测试钉住 judge 也带键、人格仍是 judge 的。
