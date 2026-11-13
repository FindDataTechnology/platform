# agent-fleet-architect Delta — add-fleet-architect-pack

## ADDED Requirements

### Requirement: 架构师工具面以三段分离暴露舰队编排能力

系统 SHALL 向对话 persona 暴露舰队架构师工具面,含五工具:`fleet_list`(owner 舰队名册:标识、名称、状态、岗数、健康概要)、`fleet_spec_read`(单舰队完整 spec:组织树、岗位 targetRef、节奏、模型声明,只读)、`fleet_draft`(草稿 dry-run:校验 + 归一化 diff + 成本预估,不落库)、`fleet_apply`(执行草稿,写走既有舰队写路径)、`fleet_turns_read`(回合事件读:舰队级 status/source 过滤,数据源与 O1 读面同源)。工具桥 SHALL 仅接受 loopback 调用,身份 SHALL 由服务端解析为 cell owner;读写作用域 SHALL 与舰队 owner 门等价。草稿 SHALL 同时支持新建舰队与既有舰队的成员操作集(建/改/停/复/删岗与舰队改名)。

#### Scenario: 读态三件套

- **WHEN** 用户问「我有哪几支舰队,现在谁在连续失败」
- **THEN** 架构师以 fleet_list 取名册、以 fleet_turns_read 过滤 failed,回答含舰队名与失败岗位及 errorKind,不涉及任何凭据

#### Scenario: 草稿不落库

- **WHEN** fleet_draft 提交一份新建三岗舰队的草稿
- **THEN** 返回校验结果与 diff,且舰队库中不出现任何新舰队或岗位

#### Scenario: 桥身份为 cell owner

- **WHEN** 工具面发起任何读写
- **THEN** 服务端以 cell owner 身份执行,作用域与该 owner 的舰队门一致;非 loopback 调用被既有鉴权拒绝

### Requirement: 草稿 dry-run 校验必经且产出 diff 与成本预估

`fleet_draft` SHALL 在服务端对草稿做完整校验后才返回结果:岗位字段形状、cron 可解析且时区合法、目标存在(persona/cluster/a2a)、唯一岗不冲突、组织树无环、单父下级数量(span)超 8 警告、cron 周期短于地板值警告。校验 SHALL 区分错误(阻断 apply)与警告(呈现在 diff 里);归一化 diff SHALL 逐岗列出操作(新建/修改/暂停/恢复/删除)与关键字段变更。凡草稿「新增岗位 >5 或含任一新 cron 节奏」,返回 SHALL 必含成本预估:每新节奏岗 turns/day 与舰队 tokens/month 区间(区间假设来自环境配置,默认 3k–8k tokens/回合)。`fleet_apply` SHALL 在执行前对同一草稿重跑校验,草稿与库状态漂移时如实报错并拒绝执行。

#### Scenario: 阻断性校验拒绝

- **WHEN** 草稿含一条 cron 表达式不可解析的岗
- **THEN** fleet_draft 返回结构化错误指名该岗,apply 对该草稿必拒

#### Scenario: 大改必显预估

- **WHEN** 草稿新建一支 7 岗舰队且 5 岗带每分钟级 cron
- **THEN** 返回含每岗 turns/day 与舰队 tokens/month 区间的预估段

#### Scenario: apply 重校验挡漂移

- **WHEN** 草稿校验通过后、apply 前,目标岗被另一路径删除
- **THEN** fleet_apply 以结构化错误拒绝并指名漂移岗位

### Requirement: 批准纪律由架构师角色承载且 apply 有兜底

架构师 persona(官方种子)的系统提示 SHALL 钉死编排纪律:任何写操作前 SHALL 在对话中完整呈现草稿 diff 与预估;SHALL 等待用户明确批准后才调用 fleet_apply;对用户描述的未知组织范式 SHALL 以现行结构(组织树 + 节奏 + 被动岗)逼近并呈现,SHALL NOT 以「不支持」直接拒绝或超出草稿自由发挥。本能力 SHALL NOT 引入独立的结构化批准工具(批准是对话级);fleet_apply 的重校验 SHALL 是状态兜底,而纪律的执行载体是角色提示与工具描述。

#### Scenario: 未知范式逼近

- **WHEN** 用户要求「康奈尔式笔记流水线」这类超出当前模式词汇的组织
- **THEN** 架构师以组织树+节奏+被动岗的组合逼近,画出结构给用户确认,而非拒绝

#### Scenario: 未批准不写

- **WHEN** 架构师已呈现 diff 但用户尚未回复批准
- **THEN** 对话中不发生任何 fleet_apply 调用
