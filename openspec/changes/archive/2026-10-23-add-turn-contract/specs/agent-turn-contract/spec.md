# agent-turn-contract Delta — add-turn-contract

## ADDED Requirements

### Requirement: 一次回合以 turnRequest 显式契约描述

系统 SHALL 以纯函数从任务引擎的回合记录派生显式契约 turnRequest,至少含:`source`(谁发起)、`targetRef {kind, id}`(执行目标)、`brief`(自包含任务说明)、`evidence`(触发依据:sourceTag / origin / initiator,可空)、`resultSink`(结果去向)、`depth`(0=外部发起)、`budget`(可空,继承目标岗超时)。既有全部触发路径 SHALL 均可表达为其实例:cron 节奏回合(source=cron、resultSink=report)、拍板批复 execute-now 回合(source=manual)、delegation 唤醒回合(source=delegation、resultSink=caller)、集群扇出成员(多次 source=cron 并行)、a2a 外发(depth=1)、以及无舰队归属的普通任务(照常表达,evidence 空)。派生 SHALL 不产生副作用、不读写运行态。

#### Scenario: cron 节奏回合

- **WHEN** 一支舰队物化 cron 任务触发岗位回合
- **THEN** 派生 source=cron、evidence.sourceTag 含舰队与岗位标识、resultSink=report、depth=0

#### Scenario: delegation 唤醒回合

- **WHEN** 一条携带 initiator 的 manual 任务唤醒被动岗
- **THEN** 派生 source=delegation、resultSink=caller(与聚合回投事实一致)、depth=0

#### Scenario: a2a 外发回合

- **WHEN** 一条 a2a 目标任务执行远程回合
- **THEN** 派生 depth=1(与既有外发深度头事实一致),不虚构更深的链

#### Scenario: 非舰队任务零例外

- **WHEN** 一个与舰队无关的普通 cron/manual 任务被派生
- **THEN** 契约照常产出(evidence 空、归属判定为无),不报错不落库

### Requirement: 契约取值受界且保留位结构化拒绝

`source` 现行取值 SHALL 为 cron|manual|delegation;peer 与 event 为派发(O3)与事件(O4)的保留位,当前构造 SHALL 以结构化错误拒绝并说明保留去向。`resultSink` 现行取值 SHALL 为 report|caller;blackboard 为黑板(O5)保留位,同样结构化拒绝。`depth` SHALL 有上限 1,超界 SHALL 结构化拒绝——这是未来派发递增的预置闸门,防链式放大。取值集合 SHALL 以常量导出,派生与校验共用一份真源。

#### Scenario: 保留源拒绝

- **WHEN** 以 source=peer 构造契约
- **THEN** 结构化错误指明 peer 为派发保留位、当前不可构造

#### Scenario: 深度超界拒绝

- **WHEN** 以 depth=2 构造契约
- **THEN** 结构化错误拒绝并指明上限 1

### Requirement: 回合执行路径消费契约后行为等价

回合收口与回合事件记录 SHALL 消费同一份派生(单一定源),消费后既有回合行为 SHALL 与现状等价:preset 归位、模型归位、身份注入、报数通道、O1 事件的字段与三源判定全部照常。等价性 SHALL 由既有测试套件(舰队八套)全绿证明,且不引入第二执行路径、不改任务引擎调度语义。

#### Scenario: 单一定源

- **WHEN** 一条 delegation 唤醒回合结束并记录 O1 事件
- **THEN** 事件的 source 与该回合 turnRequest.source 出自同一次派生,判定规则只有一份

#### Scenario: 等价 harness

- **WHEN** 本 change 落地后运行全部既有舰队测试套件
- **THEN** 零新增红——归位/注入/报数/事件/架构师各面行为与现状逐面等价
