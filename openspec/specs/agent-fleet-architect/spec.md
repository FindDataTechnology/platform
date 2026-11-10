# spec.md Specification

## Purpose

壹座聊天内的舰队自然语言编排面:一个持有舰队读写工具的「架构师」角色,把用户的自然语言编译为舰队 spec 草稿,经 dry-run 校验、diff 呈现、用户批准后走既有舰队写路径落地。读写分离(读态/起草/落地三段工具面),批准是对话级纪律、apply 重校验兜底;执行真源始终是既有舰队服务与任务引擎,本能力不引入第二写路径或第二调度器。

## Requirements

### Requirement: 架构师工具面以三段分离暴露舰队编排能力

系统 SHALL 向对话 persona 暴露集群架构师工具面,含五工具:`fleet_list`(owner 舰队名册:标识、名称、状态、岗数、健康概要;名册 SHALL 默认**完整**下发——漏项会让架构师判定该舰队不存在——但 SHALL 只含这六个字段并以紧凑形式输出,业务态不在名册上重发;另设病态规模硬上限,超限 SHALL 回带真实总数并置 truncated)、`fleet_spec_read`(单舰队完整 spec:组织树、岗位 targetRef、节奏、模型声明,只读)、`fleet_draft`(草稿 dry-run:校验 + 归一化 diff + 成本预估,不落库)、`fleet_apply`(执行草稿,写走既有舰队写路径)、`fleet_turns_read`(回合事件读:舰队级 status/source 过滤,数据源与 O1 读面同源;返回 SHALL 分页并只含诊断字段——默认 20 条、上限 100,错误串截断,并回带本次页大小与是否截断,SHALL NOT 以美化缩进输出全字段全量)。工具桥 SHALL 仅接受 loopback 调用,身份 SHALL 由服务端解析为 cell owner;读写作用域 SHALL 与舰队 owner 门等价。草稿 SHALL 同时支持新建舰队与既有舰队的成员操作集(建/改/停/复/删岗与舰队改名)。

草稿与执行两段 SHALL 另经 owner 鉴权的驾驶舱路由对浏览器会话开放(供驾驶舱设计模式使用):该路由与工具面 SHALL 共用同一校验、diff、成本预估与落地逻辑,语义(校验必经、阻断错误、成本预估触发条件、apply 重校验与漂移拒绝)逐项等价;该路由 SHALL 仅接受 owner 鉴权的会话、作用域限于该 owner 的舰队、不暴露任何凭据;工具桥的 loopback-only 与 cell owner 身份解析 SHALL 不变。

#### Scenario: 读态三件套

- **WHEN** 用户问「我有哪几支舰队,现在谁在连续失败」
- **THEN** 架构师以 fleet_list 取名册、以 fleet_turns_read 过滤 failed,回答含舰队名与失败岗位及 errorKind,不涉及任何凭据

#### Scenario: 草稿不落库

- **WHEN** fleet_draft 提交一份新建三岗舰队的草稿
- **THEN** 返回校验结果与 diff,且舰队库中不出现任何新舰队或岗位

#### Scenario: 桥身份为 cell owner

- **WHEN** 工具面发起任何读写
- **THEN** 服务端以 cell owner 身份执行,作用域与该 owner 的舰队门一致;非 loopback 调用被既有鉴权拒绝

#### Scenario: 驾驶舱路由与工具面同判

- **WHEN** 同一份含成环 handoff 边的草稿分别经工具面 fleet_draft 与驾驶舱草稿路由提交
- **THEN** 两路返回同一结构化错误指名成环边;两路 apply 均拒

#### Scenario: 驾驶舱路由鉴权

- **WHEN** 未鉴权会话或非 owner 会话调用驾驶舱草稿/执行路由
- **THEN** 与舰队管理面同一规则拒绝;工具桥对非 loopback 调用的拒绝不变

#### Scenario: 回合读面分页且不自称全量

- **WHEN** 某舰队有 150 条失败回合，架构师以默认参数调用 `fleet_turns_read`
- **THEN** 返回至多 20 条诊断字段（id/岗位/source/status/errorKind/错误首段/时间/用量/链位），并回带页大小与 truncated=true

#### Scenario: 名册完整且轻

- **WHEN** owner 有 57 支舰队，架构师调用 `fleet_list`
- **THEN** 返回全部 57 行，每行仅 id/name/state/memberCount/openDecisions/failing，紧凑输出，truncated=false

#### Scenario: 病态规模如实标注

- **WHEN** owner 的舰队数超过名册硬上限
- **THEN** 返回上限条数并置 truncated=true、回带真实总数，SHALL NOT 静默截断

### Requirement: 草稿 dry-run 校验必经且产出 diff 与成本预估

`fleet_draft` SHALL 在服务端对草稿做完整校验后才返回结果:岗位字段形状、cron 可解析且时区合法、目标存在(persona/cluster/a2a/tool)、唯一岗不冲突、组织树无环、单父下级数量(span)超 8 警告、cron 周期短于地板值警告。草稿携带 `fleet.orchestration` 段(mode/constraints/edges)时,校验 SHALL 先将成员操作虚拟应用到终态(新建/修改/删除后的成员集),再对该终态跑编排图校验(复用舰队写面同一校验函数):边引用的岗位 SHALL 允许在同一草稿中新建(链式表达合法),图错误(环/链深/未知引用/自边)SHALL 为阻断错误,span 类警告进 diff。归一化 diff SHALL 逐岗列出操作(新建/修改/暂停/恢复/删除)与关键字段变更,并逐行呈现 orchestration:mode、约束、每条边(kind/from/to/args);supervisor 模式 SHALL 提示隐式全对派发许可(读时展开,不落库展开结果)。凡草稿「新增岗位 >5 或含任一新 cron 节奏」,返回 SHALL 必含成本预估:每新节奏岗 turns/day 与舰队 tokens/month 区间(区间假设来自环境配置,默认 3k–8k tokens/回合;工具岗 turns 计、tokens 零)。`fleet_apply` SHALL 在执行前对同一草稿重跑校验(含图校验),草稿与库状态漂移时——含边引用的岗位已删除或既有 orchestration 已被他路改写——如实报错并拒绝执行;create 模式 orchestration 随舰队落库(生而全队暂停惯例不变),edit 模式在成员操作后随舰队更新落库。

#### Scenario: 阻断性校验拒绝

- **WHEN** 草稿含一条 cron 表达式不可解析的岗
- **THEN** fleet_draft 返回结构化错误指名该岗,apply 对该草稿必拒

#### Scenario: 大改必显预估

- **WHEN** 草稿新建一支 7 岗舰队且 5 岗带每分钟级 cron
- **THEN** 返回含每岗 turns/day 与舰队 tokens/month 区间的预估段

#### Scenario: apply 重校验挡漂移

- **WHEN** 草稿校验通过后、apply 前,目标岗被另一路径删除
- **THEN** fleet_apply 以结构化错误拒绝并指名漂移岗位

#### Scenario: 同草稿建岗并被边引用

- **WHEN** 草稿新建岗位「抓取」「撰稿」并声明 handoff 边 抓取→撰稿
- **THEN** 校验对草稿终态成员集通过,diff 呈两岗一行与边一行

#### Scenario: 边图错误阻断

- **WHEN** 草稿声明的 handoff 边构成环,或引用不存在的岗位
- **THEN** fleet_draft 返回结构化错误指名成环边/未知引用,apply 必拒

#### Scenario: 边漂移挡 apply

- **WHEN** 草稿通过后、apply 前,边引用的岗位被另一路径删除
- **THEN** fleet_apply 以结构化错误拒绝并指名漂移的边

### Requirement: 批准纪律由架构师角色承载且 apply 有兜底

架构师 persona(官方种子)的系统提示 SHALL 钉死编排纪律:任何写操作前 SHALL 在对话中完整呈现草稿 diff 与预估;SHALL 等待用户明确批准后才调用 fleet_apply;对用户描述的未知组织范式 SHALL 以现行结构(组织树 + 节奏 + 被动岗)逼近并呈现,SHALL NOT 以「不支持」直接拒绝或超出草稿自由发挥。本能力 SHALL NOT 引入独立的结构化批准工具(批准是对话级);fleet_apply 的重校验 SHALL 是状态兜底,而纪律的执行载体是角色提示与工具描述。

#### Scenario: 未知范式逼近

- **WHEN** 用户要求「康奈尔式笔记流水线」这类超出当前模式词汇的组织
- **THEN** 架构师以组织树+节奏+被动岗的组合逼近,画出结构给用户确认,而非拒绝

#### Scenario: 未批准不写

- **WHEN** 架构师已呈现 diff 但用户尚未回复批准
- **THEN** 对话中不发生任何 fleet_apply 调用
