## MODIFIED Requirements

### Requirement: 一次回合以 turnRequest 显式契约描述

系统 SHALL 以纯函数从任务引擎的回合记录派生显式契约 turnRequest,至少含:`source`(谁发起)、`targetRef {kind, id}`(执行目标)、`brief`(自包含任务说明)、`evidence`(触发依据:sourceTag / origin / initiator,可空)、`resultSink`(结果去向)、`depth`(0=外部发起)、`budget`(可空,继承目标岗超时)、`chain`(可空:`{runId, parentTurnId, edgeKind}`,自任务记录携带的链位信息派生——根回合为空,派发/流转/扇出点火的下游回合非空)。既有全部触发路径 SHALL 均可表达为其实例:cron 节奏回合(source=cron、resultSink=report、chain 空)、拍板批复 execute-now 回合(source=manual、chain 空)、delegation 唤醒回合(source=delegation、resultSink=caller、chain 非空且 edgeKind=dispatch)、流转接棒回合(chain 非空且 edgeKind=handoff)、集群扇出成员(多次 source=cron 并行)、a2a 外发(depth=1)、事件唤醒回合(source=event、chain 空)、以及无舰队归属的普通任务(照常表达,evidence 与 chain 空)。派生 SHALL 不产生副作用、不读写运行态、不铸造标识——runId 的铸造发生在根回合事件写入侧,派生只读任务已携带的值。

#### Scenario: cron 节奏回合

- **WHEN** 一支舰队物化 cron 任务触发岗位回合
- **THEN** 派生 source=cron、evidence.sourceTag 含舰队与岗位标识、resultSink=report、depth=0、chain 空

#### Scenario: delegation 唤醒回合

- **WHEN** 一条携带 initiator 与链位信息的 manual 任务唤醒被动岗
- **THEN** 派生 source=delegation、resultSink=caller(与聚合回投事实一致)、depth=0、chain 含发起回合的 runId 与 parentTurnId、edgeKind=dispatch

#### Scenario: 流转接棒回合

- **WHEN** 一条由 handoff 边点火、携带链位信息的接棒任务执行
- **THEN** 派生 chain.edgeKind=handoff、runId 与上游回合相同、parentTurnId=上游回合标识

#### Scenario: a2a 外发回合

- **WHEN** 一条 a2a 目标任务执行远程回合
- **THEN** 派生 depth=1(与既有外发深度头事实一致),不虚构更深的链

#### Scenario: 非舰队任务零例外

- **WHEN** 一个与舰队无关的普通 cron/manual 任务被派生
- **THEN** 契约照常产出(evidence 空、chain 空、归属判定为无),不报错不落库

#### Scenario: 派生不铸造

- **WHEN** 对同一条不携带链位信息的根任务记录派生两次
- **THEN** 两次结果逐字段相等且 chain 均为空,派生过程不生成任何标识
