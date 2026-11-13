## ADDED Requirements

### Requirement: 边回合按精简形态接上舰队上下文

派发、接棒、扇出、事件唤醒四类边回合的 persona 目标 SHALL 获得舰队上下文，渲染 SHALL 走与巡视轮**同一个执行侧注入缝**（每次执行恰好一次，渲染失败使该次执行显性失败）。边回合的上下文 SHALL 以独立占位符 `{{fleetEdgeContext}}` 声明，SHALL NOT 与巡视轮的 `{{fleetContext}}` 混用同一形态。

边回合形态 SHALL 包含：舰队在岗概况、直接下级岗位的最新报数摘要、本岗位自身最近轮次与近期执行健康。边回合形态 SHALL NOT 包含巡逻纪律尾段（其中"先报数再补充/调用 report_status"的指示针对巡视轮，对一条刚被交付任务的回合是反向指令），SHALL NOT 渲染决策送达段（送达是巡视轮的义务，在边回合消费会把未读裁决标记为已送达），且其总量上限 SHALL 小于巡视轮上限，使舰队背景不挤占回合自身的主料（派发 brief、上游结果、唤醒消息）。

a2a 目标与 tool 目标 SHALL NOT 注入：a2a 目标是其他服务的执行面；tool 岗位的 prompt 就是其 JSON 参数，追加文本会使之非法。tool 目标的 prompt SHALL 与 brief 逐字节相同。巡检轮（`{{fleetContext}}`）的渲染 SHALL 与本能力引入前逐字节等价。

#### Scenario: 派发到 persona 岗位拿到集群背景

- **WHEN** 岗位 A 派发 persona 岗位 B 并给出 brief，B 的回合开始
- **THEN** B 的起轮 prompt 含 brief 在前、集群背景在后；背景含在岗概况与 B 的直接下级最新报数，且不含巡逻纪律段

#### Scenario: 接棒与扇出同形

- **WHEN** 上游回合完成后依声明边接棒或扇出一波 persona 目标
- **THEN** 每个目标回合的 prompt 含上游结果与集群背景，占位符不残留

#### Scenario: 事件唤醒的岗位知道组织现状

- **WHEN** bot 入站消息唤醒绑定的 persona 岗位
- **THEN** 该回合 prompt 含该消息与集群背景（在岗概况 + 下级最新报数），不含巡逻纪律段

#### Scenario: a2a 与 tool 目标零注入

- **WHEN** 派发或唤醒命中 a2a 目标，或派发命中 tool 目标
- **THEN** a2a 的 prompt 不含任何舰队上下文 token；tool 的 prompt 与 brief 参数逐字节相同

#### Scenario: 边回合不消耗决策送达

- **WHEN** 某岗位存在未送达的裁决，且该岗位本轮是被派发/接棒/扇出/唤醒触发的
- **THEN** 该回合 prompt 不含裁决送达段，该裁决在该回合后仍为未送达

#### Scenario: 边回合渲染失败显性化

- **WHEN** 边回合的上下文渲染抛错
- **THEN** 该次执行记为失败且不起一轮无背景的裸回合

#### Scenario: 巡视轮零变化

- **WHEN** 岗位节奏模板含 `{{fleetContext}}`
- **THEN** 渲染结果与引入本能力前逐字节一致（含巡逻纪律尾段与决策送达段）
