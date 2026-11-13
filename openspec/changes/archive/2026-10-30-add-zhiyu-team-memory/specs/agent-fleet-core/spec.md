# agent-fleet-core delta

## ADDED Requirements

### Requirement: 岗位记忆独立于对话史存在

岗位的连续性 SHALL 由三层承载且边界清晰：对话史（岗位镜像会话，换防清史重开可清）、报数史与
KPI 槽位连续性（既有语义，任何换防不清）、**岗位记忆**（owner 永忆 `f/` 团队 project 中的历史观测，
openspec: fleet-turn-memory——永不删页，任何换防/清史/解散都不删除）。清史重开的「清」字 SHALL 限于
镜像会话对话史；解散团队 SHALL NOT 删除已入记忆的历史观测（记忆归 owner，不随资产销毁）。
回合注入侧由 fleetContext 记忆段接续（本 spec 不重复其渲染契约）。

#### Scenario: 解散不清记忆

- **WHEN** 主人解散一支已有历史观测的团队
- **THEN** 团队与物化任务按既有语义终止，其在 owner 记忆 `f/` project 中的观测原样保留、可检索

#### Scenario: 清史重开的边界

- **WHEN** 主人勾选清史重开换防
- **THEN** 镜像会话对话史清空重建，岗位记忆与报数史/KPI 槽位连续性均不受影响（与既有验收口径一致并扩展到记忆层）
