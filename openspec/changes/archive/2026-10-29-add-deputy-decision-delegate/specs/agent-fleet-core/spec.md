## ADDED Requirements

### Requirement: 拍板队列与管理面暴露裁决者身份与执行状态

舰队拍板队列读面与管理面 SHALL 能按路由（owner / deputy）过滤与查看拍板项，条目 SHALL 暴露裁决者身份（owner / deputy 及 deputy 所用模型）、裁决依据、执行事实（executed 时刻与会话）与结果派生来源；route=deputy 的条目 SHALL 与 owner 待办在视觉与计数上区分。fleet 主人对 route=deputy 的条目 SHALL 可执行收回（recall → 路由 owner）。

#### Scenario: 队列按路由分视

- **WHEN** 主人打开拍板管理面
- **THEN** 可分别查看「等你（route=owner）」与「常务岗（route=deputy，含裁决中/已裁决/跟踪中）」两个视图

#### Scenario: 主人收回委托

- **WHEN** 主人对一条 route=deputy 的 open 条目执行收回
- **THEN** 该条目转路由 owner 并计入主人角标，deputy 队列不再包含它
