## MODIFIED Requirements

### Requirement: 架构师工具面以三段分离暴露舰队编排能力

系统 SHALL 向对话 persona 暴露集群架构师工具面,含五工具:`fleet_list`(owner 舰队名册:标识、名称、状态、岗数、健康概要)、`fleet_spec_read`(单舰队完整 spec:组织树、岗位 targetRef、节奏、模型声明,只读)、`fleet_draft`(草稿 dry-run:校验 + 归一化 diff + 成本预估,不落库)、`fleet_apply`(执行草稿,写走既有舰队写路径)、`fleet_turns_read`(回合事件读:舰队级 status/source 过滤,数据源与 O1 读面同源;返回 SHALL 分页并只含诊断字段——默认 20 条、上限 100,错误串截断,并回带本次页大小与是否截断,SHALL NOT 以美化缩进输出全字段全量)。工具桥 SHALL 仅接受 loopback 调用,身份 SHALL 由服务端解析为 cell owner;读写作用域 SHALL 与舰队 owner 门等价。草稿 SHALL 同时支持新建舰队与既有舰队的成员操作集(建/改/停/复/删岗与舰队改名)。

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

