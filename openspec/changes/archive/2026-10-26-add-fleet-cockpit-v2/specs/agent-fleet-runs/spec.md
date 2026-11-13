## Purpose

一次点火到收束的「执行实例」(run)是舰队可观测的一等对象:同源回合串成一串、链位成边、回合明细可回放、变化按舰队实时推送——它是驾驶舱活画布与回放时间线的数据骨架,补上 v1 只有「声明」与「节点态」而没有「实例」的缺口。

## ADDED Requirements

### Requirement: 执行实例以 runId 贯穿同源回合链

根回合(source 为 cron|event|manual 且不携带上游链位)SHALL 在其回合结果事件写入时铸造 runId;由派发(dispatch)、流转(handoff)、扇出(fanout)点火的下游回合 SHALL 沿任务携带的链位信息继承其发起回合的 runId,并记录 parentTurnId(发起回合标识)与 edgeKind(dispatch|handoff|fanout)。链位信息 SHALL 由点火侧在创建下游任务时写入任务记录,回合契约派生 SHALL 只读该信息、不产生副作用、不引入第二套身份判定。非舰队回合 SHALL 不产生 run。同一 run 的首个回合开始时 SHALL 落一条头表行(舰队标识、根来源、根岗位、开始时刻、状态 open);run 内最后一个回合结束后 SHALL 收口头表(结束时刻、状态 ok|failed|partial、合计:回合数/成功数/失败数/token 合计);收口 SHALL 幂等。

#### Scenario: 定时根回合铸造 run

- **WHEN** 一支舰队的定时运行触发某岗位的根回合并结束
- **THEN** 该回合事件携带新铸造的 runId、parentTurnId 为空、edgeKind 为空,头表出现一行根来源=cron、根岗位=该岗的 run

#### Scenario: 流转回合继承链位

- **WHEN** 一条 handoff 边在上游回合结束后点火下游岗位并完成回合
- **THEN** 下游回合事件的 runId 与上游相同、parentTurnId=上游回合标识、edgeKind=handoff

#### Scenario: 三跳同串成树

- **WHEN** 根回合派发岗位甲,甲流转岗位乙,乙扇出岗位丙与丁
- **THEN** 五个回合事件 runId 相同,以 parentTurnId×edgeKind 还原为一棵以根回合为根的链位树

#### Scenario: 非舰队回合零 run

- **WHEN** 一个无舰队归属的普通定时任务执行
- **THEN** 不产生任何 run 头表行,其记录不携带 runId

#### Scenario: 收口幂等且合计一致

- **WHEN** 一 run 的最后一个回合结束
- **THEN** 头表行闭合,合计与该 run 全部回合事件逐项一致;重复收口不改写已闭合的头表

### Requirement: 执行实例可查询且含明细链

系统 SHALL 提供 run 读面:按舰队分页列出 run(可按状态、根来源、时段过滤;每行含 runId、根来源、根岗位、起止时刻、时长、回合数、token 合计、状态),与单 run 详情(按时间有序的回合列表,每回合含岗位标识、source、status、errorKind、起止时刻、执行模型、usage、来源会话、parentTurnId、edgeKind、trace 关联键)。读面 SHALL 仅暴露舰队域字段,不携带凭据与会话正文;owner 作用域 SHALL 与舰队读面一致;分页 SHALL 有界(默认页大小与上限由服务端定)。

#### Scenario: 列表按状态与时段过滤

- **WHEN** 请求某舰队 status=failed 且近 24 小时的 run 列表
- **THEN** 仅返回同时满足两条件的 run 行,每行含 token 合计与时长

#### Scenario: 详情可还原链位

- **WHEN** 请求某 run 的详情
- **THEN** 回合按开始时刻有序返回,流转/派发/扇出的父子关系可自 parentTurnId×edgeKind 完整还原

#### Scenario: 越权与此前读面一致地拒绝

- **WHEN** 非 owner 请求某舰队的 run 读面
- **THEN** 与舰队管理面同一规则拒绝,不泄露 run 是否存在

### Requirement: 舰队回合与运行时事件流可关联

回合结果事件 SHALL 携带 trace 关联键 traceTurnId;舰队回合(定时/派发/流转/扇出/事件唤醒)的运行时事件 SHALL 与网页会话同样被记录进既有 trace 存储并以 traceTurnId 为键,记录内容范围与保留策略沿用既有 trace 面(含去 delta、按天保留)。无法记录的回合 SHALL 将 traceTurnId 置空而非虚构;run 详情读面 SHALL 如实呈现该缺失。

#### Scenario: 工具调用序列可取回

- **WHEN** 某舰队回合内发生两次工具调用
- **THEN** 以该回合事件的 traceTurnId 可自 trace 读面取回这两次调用的起止与名称

#### Scenario: 不虚构关联

- **WHEN** 某回合因运行时约束未产生可记录的事件流
- **THEN** 其回合事件 traceTurnId 为空,run 详情中该回合标注无 trace,不报错

### Requirement: 舰队实时事件推送

系统 SHALL 于舰队回合开始与结束时各广播一条舰队事件(含舰队标识、岗位标识、runId、回合标识、parentTurnId、edgeKind、状态、起止时刻),并于 run 头表创建与收口时广播 run 更新事件。事件 SHALL 经既有广播通道投递、仅含舰队域字段、不含凭据与会话正文。驾驶舱客户端 SHALL 可仅凭事件流增量更新节点与边的在途态;事件丢失时 SHALL 可由整体读面的下一次拉取自愈,不产生永久错显。

#### Scenario: 回合开始即点亮

- **WHEN** 某岗位回合开始
- **THEN** 已打开该舰队驾驶舱的客户端收到开始事件,该岗位节点与其入边切换为在途态

#### Scenario: 回合结束即收束

- **WHEN** 该回合结束
- **THEN** 客户端收到结束事件(含 status 与 errorKind),节点退出在途态并呈现本回合结果

#### Scenario: 断流自愈

- **WHEN** 客户端错过了若干条事件后重新拉取整体读面
- **THEN** 节点与边的状态与服务端收敛一致,不残留虚假在途态

### Requirement: 执行实例有界保留

run 头表与其回合明细 SHALL 以同一时间窗(默认 30 天)裁剪,与回合结果事件的「时间 + 每岗下限」双条件保留协同:仅当 run 闭合且早于保留窗时头表才可被裁剪;裁剪 SHALL 只删最旧、不影响产出与审批历史;单侧残留(头表已裁而明细因每岗下限仍在,或反之)SHALL 不产生错误——明细读面照常可读,run 列表不呈现已裁头表。

#### Scenario: 过窗裁剪

- **WHEN** 某 run 闭合已超过保留窗
- **THEN** 其头表被裁剪,产出与审批历史不受影响

#### Scenario: 单侧残留无错

- **WHEN** 某岗位的回合明细因每岗下限仍被保留而其所属 run 头表已被裁剪
- **THEN** 该岗位回合时间线照常返回这些明细,run 列表不含该 run,无错误
