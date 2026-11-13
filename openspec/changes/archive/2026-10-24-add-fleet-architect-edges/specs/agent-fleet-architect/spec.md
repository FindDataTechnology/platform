# agent-fleet-architect Delta — add-fleet-architect-edges

## MODIFIED Requirements

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
