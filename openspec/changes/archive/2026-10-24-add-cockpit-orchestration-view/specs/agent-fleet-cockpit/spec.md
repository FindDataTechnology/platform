# agent-fleet-cockpit Delta — add-cockpit-orchestration-view

## ADDED Requirements

### Requirement: 驾驶舱呈现舰队编排声明

舰队驾驶舱 SHALL 在组织结构区呈现该舰队的 orchestration 声明(当且仅当已声明):模式徽章(schedule|supervisor|pipeline,supervisor 附隐式全对派发许可提示)、约束摘要(链深上限/每跳预算)、边列表逐行——每条边呈现类型徽章(trigger|report|dispatch|handoff|fanout|event)、发起与目标岗位的**岗位名**(fanout 呈全部 targets 与聚合式,judge 式指名裁决岗;event 呈外部信号源名)。岗位标识 SHALL 解析为岗位名渲染;隐式展开的边 SHALL 带隐式标记。未声明 orchestration 的舰队 SHALL 不渲染该区(视图与现状一致)。本区 SHALL 为纯读面,不引入任何写路径。

#### Scenario: 声明呈现

- **WHEN** 一支声明 supervisor 模式与 投资部→开源部 handoff 边的舰队打开驾驶舱
- **THEN** 编排区呈现 supervisor 徽章(含隐式许可提示)与一行 handoff 边(岗位名渲染)

#### Scenario: fanout 边语义呈现

- **WHEN** 一条 fanout 边 targets=[电商部,助理部] judge=CEO 声明在案
- **THEN** 边行呈现 fanout 徽章、两目标岗位名与「裁决:CEO」

#### Scenario: 未声明零噪音

- **WHEN** 一支未声明 orchestration 的舰队打开驾驶舱
- **THEN** 不出现编排区,其余视图与现状逐字节一致
