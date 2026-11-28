# spec.md Specification

## Purpose

一次回合的显式契约:以纯函数从任务引擎记录派生 turnRequest(source/targetRef/brief/evidence/resultSink/depth/budget),覆盖既有全部触发路径;取值受界(保留位按去向指名拒绝),深度界 1 为派发递增预置闸门;回合执行路径消费同一份派生后行为与现状等价。是编导代数(舰队编排路线 explore 底稿)的执行原语。

## Requirements

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

### Requirement: 契约取值受界且保留位结构化拒绝

`source` 现行取值 SHALL 为 cron|manual|delegation|event——event 为已绑定的第一信号源(bot 入站唤醒,派生自 evidence.origin.event);peer 仍为派发(O3)保留位,当前构造 SHALL 以结构化错误拒绝并说明保留去向。`resultSink` 现行取值 SHALL 为 report|caller;blackboard 为黑板(O5)保留位,同样结构化拒绝。深度上限 SHALL 按**道**分界:dispatch 道(运行期临时派发)SHALL 界 1;handoff 道(经图校验的声明链)SHALL 界为该舰队声明的 maxChainDepth(缺省默认 8);event 唤醒的回合 SHALL 深度 0(外部发起)。超界 SHALL 结构化拒绝——防链式放大的语义保留,边界来源从全局常量改为声明约束。该拒绝 SHALL 在**回合执行侧**再校验一次:舰队起轮前 SHALL 以当前声明的 maxChainDepth 校验派生出的 turnRequest，超界则本轮以结构化错误收口并落一条回合事件——声明在链位入队后被收紧时，已排队的超界回合 SHALL NOT 照常运行（校验常量与派生共用一份真源）。取值集合与各界 SHALL 以常量导出,派生与校验共用一份真源。

#### Scenario: 保留源拒绝

- **WHEN** 以 source=peer 构造契约
- **THEN** 结构化错误指明 peer 为派发保留位、当前不可构造

#### Scenario: 深度超界拒绝

- **WHEN** 以 depth=2 构造 dispatch 道契约
- **THEN** 结构化错误拒绝并指明该道上限

#### Scenario: 派发道深度拒绝

- **WHEN** 以 source=delegation、depth=2 构造契约(无声明链背书)
- **THEN** 结构化错误拒绝并指明 dispatch 道上限 1

#### Scenario: 声明链内深度放行

- **WHEN** 一支舰队声明 maxChainDepth=5,以 handoff 链位 3 构造契约
- **THEN** 校验通过;链位 6 被拒

#### Scenario: 事件源派生

- **WHEN** 一条携带 origin.event {botId} 的 manual 任务被派生
- **THEN** source=event、depth=0;event 为合法值不再保留

#### Scenario: 声明收紧后已排队的超界回合被拒

- **WHEN** 一个 depth=4 的接棒回合已在队列中，其舰队把 maxChainDepth 收紧为 2
- **THEN** 该回合起轮前以结构化错误拒绝（错误指明该道上限），并落一条带该错误的回合事件，SHALL NOT 照常运行

#### Scenario: 声明内的回合照常运行

- **WHEN** 一个 depth=3 的回合与舰队声明的 maxChainDepth=5
- **THEN** 起轮不因本校验产生任何行为差异（校验通过为 null，不改变回合结果）

### Requirement: 回合执行路径消费契约后行为等价

回合收口与回合事件记录 SHALL 消费同一份派生(单一定源),消费后既有回合行为 SHALL 与现状等价:preset 归位、模型归位、身份注入、报数通道、O1 事件的字段与三源判定全部照常。等价性 SHALL 由既有测试套件(舰队八套)全绿证明,且不引入第二执行路径、不改任务引擎调度语义。

#### Scenario: 单一定源

- **WHEN** 一条 delegation 唤醒回合结束并记录 O1 事件
- **THEN** 事件的 source 与该回合 turnRequest.source 出自同一次派生,判定规则只有一份

#### Scenario: 等价 harness

- **WHEN** 本 change 落地后运行全部既有舰队测试套件
- **THEN** 零新增红——归位/注入/报数/事件/架构师各面行为与现状逐面等价
