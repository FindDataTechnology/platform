# agent-fleet-orchestration Delta — add-fleet-event-wake

## MODIFIED Requirements

### Requirement: 舰队以 orchestration 声明段描述编导边与约束

舰队对象 SHALL 支持可选 `orchestration` 段:`edges`(边集)与 `constraints`(spanMax / budgetPerEdgeMin / maxChainDepth,均可缺省取默认)。边 SHALL 为六种之一:`trigger`(cron 触发某岗,= 既有节奏物化的图形态,行为不变)、`report`(报数上行,= 既有报数通道,行为不变)、`dispatch`(运行期由岗位发起的派活许可)、`handoff`(上游岗回合完成后接棒下游岗)、`fanout`(上游岗回合完成后并行扇出至多岗并按聚合式汇流)、`event`(外部信号源唤醒某岗)。每条边 SHALL 显式引用本舰岗位 ref(event 边的 from SHALL 为 `bot:<botId>` 形式的外部信号源名,存在性由运行期如实判定);系统 SHALL NOT 按建队顺序或任何隐式规则推断边。写面 SHALL 全量校验:边引用的岗位存在、handoff 子图无环、每条 handoff 链长 ≤ maxChainDepth、span ≤ spanMax(警告级)。event 边的 to SHALL 为 persona/a2a 岗(cluster 无 manual 车道、tool 的参数是逐跳 args,均结构化拒绝);event 边 SHALL NOT 参与 DAG 环检测。未声明 orchestration 段或声明为 `schedule` 模式时,系统行为 SHALL 与现状逐字节一致。

#### Scenario: 声明一条流水线

- **WHEN** 舰队声明 handoff 边 抓取→清洗→撰稿 与 trigger 边 cron(0 9 * * *)→抓取
- **THEN** 校验通过,三岗节奏物化照常(清洗/撰稿无节奏物化),每日 9 点抓取回合完成后自动接棒清洗

#### Scenario: 隐式推断被拒

- **WHEN** 声明段留空但期望按建队顺序成链
- **THEN** 不产生任何 handoff 行为;边只有显式声明一种来源

#### Scenario: 环拒绝

- **WHEN** handoff 边构成 A→B→A
- **THEN** 写面结构化拒绝并指名成环边

#### Scenario: 未声明逐字节等价

- **WHEN** 一支未声明 orchestration 的既有舰队在本 change 后运行
- **THEN** 节奏物化、报数、拍板、模型归位、事件流与现状逐字节一致(既有测试套件为等价证明)

#### Scenario: fanout 边校验

- **WHEN** 声明 fanout 边 targets 只有一个岗,或 targets 含 from 自身,或 judge 引用 targets 成员,或 rounds 为 5,或 targets 含 tool 岗
- **THEN** 写面结构化拒绝并逐项指名

#### Scenario: event 边校验

- **WHEN** 声明 event 边 from="bot:helper" to=客服岗(persona),或 to 为 cluster/tool 岗,或 from 非 bot: 形式
- **THEN** 前者通过;后两者结构化拒绝并指名原因

## ADDED Requirements

### Requirement: bot 入站消息唤醒绑定的岗位

社聊 bot 的入站消息在既有守卫(尺寸/频次)全部通过后,系统 SHALL 额外扫描舰队的 event 边:存在 `from:"bot:<该 bot>"` 的边时,SHALL 为每条边的 to 岗位创建 manual 回合——brief 含发送者与消息原文、`origin.fleet {memberId, depth:0}` 与 `origin.event {botId, chatKey}`,该回合 SHALL 经既有收口产出 source=event 的 O1 事件。bot 自身的会话回合 SHALL 照常执行(bot 答聊天,岗位异步做舰队事)。护栏:每岗每小时唤醒次数 SHALL 有上限(默认 30,环境可配),超限 SHALL 不建任务并落结构化 O1 事件如实留痕。无命中边的入站消息 SHALL 零扰动。

#### Scenario: 命中唤醒

- **WHEN** 客服 bot 收到一条消息,且某舰队声明了 event 边 bot:客服bot→客服岗
- **THEN** 客服岗起 manual 回合(prompt 含消息原文与发送者),O1 事件 source=event;bot 照常回答聊天

#### Scenario: 护栏超限

- **WHEN** 一小时内该岗被唤醒已达上限又来一条命中消息
- **THEN** 不建任务,落 O1 事件留痕拒绝

#### Scenario: 无命中零扰

- **WHEN** 一条入站消息没有任何 event 边引用该 bot
- **THEN** 不产生任何舰队任务与事件,bot 行为与现状逐字节一致
