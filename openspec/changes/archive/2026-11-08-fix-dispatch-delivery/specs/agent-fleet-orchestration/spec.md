## MODIFIED Requirements

### Requirement: dispatch 边使能同舰队岗位间派活

持有 dispatch 许可(显式 dispatch 边、supervisor 模式展开、或**声明 handoff 边的成对双向授权**)的岗位回合 SHALL 获得 `dispatch_post` 工具:按岗位 ref 派活给同舰队岗位,brief 为自包含任务说明;派发 SHALL 走既有 delegation 车道创建 manual 任务(证据 `origin.fleet` 指名目标岗、initiator 为**派发岗本回合的会话**)。initiator SHALL 取自派发归因判定出的调用来源——在飞回合用该回合的镜像会话、运行中的舰队任务用该任务的会话、聊天车道才用当前会话指针;系统 SHALL NOT 一律取运行时的全局会话指针。派发任务 SHALL 另记录派发岗的人格,使回执汇总以派发岗的口吻起回合;每次派发 SHALL 携带独立的聚合分组键,同一派发岗的多次派发 SHALL NOT 并成一次汇总。,结果 SHALL 异步送达——派发立即返回,目标岗回合摘要经聚合器在派发岗下一回合注入,系统 SHALL NOT 挂起派发回合等待。护栏 SHALL 结构化拒绝:跨舰队目标、自派、目标岗回合深度已达 1、每岗每回合派发超上限(默认 3)、舰队每小时派发超上限(默认 30,均可 env 配置)。派发目标域 SHALL 为 persona、a2a 与 tool 岗(cluster 岗无 manual 车道,SHALL 结构化拒绝)。派发与被派发回合 SHALL 经既有回合收口自动产出 O1 事件,不新增记录路径。**成对双向授权**：舰队编排声明了 handoff 边的两岗之间,dispatch 许可双向成立——上游→下游为移交、下游→上游为退回;该许可只作用于该边的两端点之间,系统 SHALL NOT 借此扩展到任何其他岗位对;许可为读时判定,系统 SHALL NOT 派生落盘的隐式边。

#### Scenario: 主管派活闭环

- **WHEN** supervisor 模式下主管岗回合内 dispatch_post(执行岗 ref, brief)
- **THEN** 执行岗起 manual 回合,brief 含派发者身份;派发岗本回合继续收尾,下回合收到执行岗回合摘要

#### Scenario: 护栏拒绝面

- **WHEN** 派发目标在另一舰队、或目标为本岗、或目标回合深度已 1、或超频次上限
- **THEN** 工具以结构化错误拒绝并指明原因,不创建任务

#### Scenario: handoff 正向移交

- **WHEN** 舰队声明 handoff 边 建模岗→校验岗,建模岗回合内 dispatch_post(校验岗 ref, brief)
- **THEN** 许可成立,校验岗起 manual 回合——建模岗无需另声明 dispatch 边

#### Scenario: handoff 反向退回

- **WHEN** 同上舰队,校验岗回合内 dispatch_post(建模岗 ref, 拦截件退回 brief)
- **THEN** 许可成立(同一声明边的反向),建模岗起 manual 回合收到拦截件

#### Scenario: 未声明对仍拒

- **WHEN** 舰队仅声明 handoff 边 盘账→建模,建模岗 dispatch_post(无关的第三岗 ref)
- **THEN** 结构化拒绝:成对授权只覆盖声明边的两端点

#### Scenario: 定时车道的派发回执回到派发岗

- **WHEN** 定时触发的派发岗回合在运行中调用 dispatch_post,而此时运行时的全局会话指针指向别处
- **THEN** 新建任务的 initiator 为该回合的镜像会话(不是全局指针),回执汇总在该派发岗的会话里起回合

#### Scenario: 聊天车道零变化

- **WHEN** 用户在聊天里以某 persona 身份调用派发
- **THEN** initiator 仍为该聊天会话,派发任务的人格为该聊天当前人格

