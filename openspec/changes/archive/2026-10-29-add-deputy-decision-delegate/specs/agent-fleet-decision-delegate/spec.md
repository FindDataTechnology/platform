# agent-fleet-decision-delegate Specification

## Purpose

拍板委托：主人可配置把部分待拍板项委托给一个 AI 代理（常务岗）裁决/分流/跟踪，裁决受服务端强制授权约束（越权即拒），裁决身份与依据入审计，执行进度可见，裁决与进度镜像进主人记忆。目标是让拍板队列只进出的积压被持续消化，而主人只处理真正需要人的事项。

## ADDED Requirements

### Requirement: 主人可配置委托策略

系统 SHALL 提供委托策略的配置面：cell 级默认 + 舰队级覆写。策略 SHALL 至少包含：按类别的路由（例行运营、问题单、配置改动、人事、花费 → owner 或 deputy）、可委托的最高严重度、deputy 每日裁决预算、裁决所用模型、汇报摘要频率。`config-change`、人事、花费三类 SHALL NOT 可配置为委托——它们永远路由 owner。策略变更 SHALL 即时生效于后续路由，SHALL NOT 追溯改写已路由条目。

#### Scenario: 主人把例行运营委托给常务岗

- **WHEN** 主人在设置面把「例行运营」类别路由为 deputy 并保存
- **THEN** 此后该类别的新拍板项在创建时即路由 deputy，不再计入主人角标

#### Scenario: 高风险类别不可委托

- **WHEN** 主人尝试把「花费」类别路由为 deputy
- **THEN** 设置面拒绝该配置并说明该类别永远路由 owner

#### Scenario: 舰队覆写关闭委托

- **WHEN** 某舰队覆写 delegation.enabled=false
- **THEN** 该舰队所有新拍板项路由 owner，行为与未启用委托前一致

### Requirement: escalate 时同步路由与归并

岗位 escalate 提交拍板项时，系统 SHALL 按当次生效策略同步设定条目路由（owner 或 deputy）；SHALL 在落库前执行归并检查——同来源岗位、近 N 天（默认 7 天）内语义相似（问题文本相似度或提交方声明的同一主题）的 open 条目存在时，新提交 SHALL 关联到既有条目（计数/时间线更新）而不产生新行，且 SHALL 向提交方返回既有条目引用。归并 SHALL NOT 跨岗位、SHALL NOT 吞掉不同问题。

#### Scenario: 同一阻塞重复升级被归并

- **WHEN** CEO 巡逻第二轮就「重复岗位注册」再次 escalate，而第一轮的相似条目仍 open
- **THEN** 不产生新行，既有条目关联本次升级（升级次数 +1），返回值指回既有条目

#### Scenario: 不同问题不误并

- **WHEN** 同一岗位提交的问题与近 7 天条目均不相似
- **THEN** 正常落新行并按策略路由

### Requirement: 常务岗以受约束工具面裁决

启用委托的舰队 SHALL 可设立常务岗（决策代理岗位）：persona 岗位，自带巡逻节奏，工具面 SHALL 至少含——读取本舰队 route=deputy 的待裁队列、读取来源岗位上下文（近期报数/状态）与主人过往判例、提交裁决（批准选定项/驳回附理由/上报主人附分析）、读写主人记忆。裁决提交 SHALL 经服务端强制授权：条目类别、严重度、当日预算逐项校验，越权 SHALL 以结构化错误拒绝且条目原样保留并转路由 owner；SHALL NOT 仅依赖代理的提示词约束。deputy 上报主人的条目 SHALL 转路由 owner 并携带其分析。

#### Scenario: 预算内裁决生效

- **WHEN** 常务岗在日预算内对一条例行运营项批准选项 X 并附依据
- **THEN** 项转 approved，resolved_by=deputy，依据与引用判例入库，走既有送达管线

#### Scenario: 越出委托被服务端拒绝

- **WHEN** 常务岗尝试裁决一条 config-change 类条目
- **THEN** 服务端以结构化错误拒绝（beyond delegation mandate），条目转路由 owner，常务岗收到拒因

#### Scenario: 判不了向上升级

- **WHEN** 常务岗对某条目无法依判例与策略裁决
- **THEN** 它可将条目转路由 owner 并附分析；项计入主人角标

### Requirement: 裁决携带身份与依据

每条裁决（owner 或 deputy）SHALL 记录裁决者身份（owner / deputy）、deputy 裁决时所用模型、裁决依据文本及其引用的判例（过往拍板项 id 或记忆条目引用）。主人过往裁决 SHALL 可被 deputy 作为判例读取。拍板队列与管理面 SHALL 展示裁决者身份与依据；deputy 裁决的条目 SHALL 与 owner 裁决在视觉上可区分。

#### Scenario: deputy 裁决可审计

- **WHEN** 常务岗批准一条例行运营项
- **THEN** 条目记录 resolved_by=deputy、所用模型、依据文本与引用的判例，队列中可见

#### Scenario: 判例来自主人历史

- **WHEN** 常务岗面对与主人过往裁决同类的问题
- **THEN** 其裁决依据 SHALL 能引用该过往拍板项（主人当时的选择与理由）

### Requirement: 委托裁决的执行进度可追踪

送达后的条目 SHALL 在送达回合完成时回填执行事实（executed 时刻与会话），其结果 SHALL 可从该回合的报数/会话派生；拍板队列与管理面 SHALL 能回答「批了没执行」与「执行了且结果如何」。deputy 的巡逻回合产出 SHALL 走既有报数管线（管理面可见），其裁决与执行进度 SHALL 镜像进主人记忆 reference 层并按策略频率汇总为摘要。

#### Scenario: 执行事实回填

- **WHEN** 一条已批准项的送达回合完成
- **THEN** 条目回填 executed 时刻与会话，队列中可区分「批了没执行」与「已执行」

#### Scenario: 主人可从记忆查证常务岗作为

- **WHEN** 主人在记忆中查询常务岗近期活动
- **THEN** 可见其裁决摘要（各裁了什么、依据）与跟踪中的问题单状态（最老未决多久）

### Requirement: 角标只计需要主人的事项

应用入口「等你 N 件」角标 SHALL 只计 route=owner 的 open 条目；route=deputy 的条目 SHALL 计入常务岗自己的队列视图。主人 SHALL 可在管理面查看 deputy 队列（含裁决中/已裁决/跟踪中的问题单）。

#### Scenario: 委托后角标下降

- **WHEN** 66 条 open 中 40 条路由 deputy 且尚未裁决
- **THEN** 主人角标计 26（route=owner），deputy 队列视图计 40

#### Scenario: 主人可收回委托

- **WHEN** 主人对一条 route=deputy 的条目选择收回（recall）
- **THEN** 条目转路由 owner 并计入主人角标，deputy 队列移除