# agent-fleet-orchestration Delta — add-fleet-fanout

## MODIFIED Requirements

### Requirement: 舰队以 orchestration 声明段描述编导边与约束

舰队对象 SHALL 支持可选 `orchestration` 段:`edges`(边集)与 `constraints`(spanMax / budgetPerEdgeMin / maxChainDepth,均可缺省取默认)。边 SHALL 为五种之一:`trigger`(cron 触发某岗,= 既有节奏物化的图形态,行为不变)、`report`(报数上行,= 既有报数通道,行为不变)、`dispatch`(运行期由岗位发起的派活许可)、`handoff`(上游岗回合完成后接棒下游岗)、`fanout`(上游岗回合完成后并行扇出至多岗并按聚合式汇流)。每条边 SHALL 显式引用本舰岗位 ref;系统 SHALL NOT 按建队顺序或任何隐式规则推断边。写面 SHALL 全量校验:边引用的岗位存在、handoff 子图无环、每条 handoff 链长 ≤ maxChainDepth、span ≤ spanMax(警告级)。fanout 边的形状与校验 SHALL 为:`targets` 至少两个岗位引用且无重复、from 不得为 targets 之一、`aggregate` 缺省为 `{kind:"all"}` 且取值 first|all|judge(judge 式必带 `judge` 岗位引用,该岗存在、非 from、非 targets 成员)、`rounds` 取 1–3(缺省 1);fanout 目标 SHALL NOT 为 tool 岗(工具岗的参数是逐跳 args,接棒语义用 handoff 边表达);fanout 边 SHALL NOT 参与 handoff 的无环检测——其成环由 rounds 有界、深度仍受 maxChainDepth 全局界。未声明 orchestration 段或声明为 `schedule` 模式时,系统行为 SHALL 与现状逐字节一致。

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

## ADDED Requirements

### Requirement: fanout 边以并行波执行且有界轮次成环

上游岗回合结束后,系统 SHALL 对其每条 fanout 出边执行一个并行波:为每个目标岗创建 manual 回合(深度按链位递增受 maxChainDepth 硬界,brief 含上游产出或失败的如实转述与轮次标注,与 handoff 同式;深度超界时 SHALL 不建任务并落结构化 O1 事件如实留痕)。聚合 SHALL 二式分流:无 judge 时,波内任务的 initiator SHALL 为上游回合会话——delegation 聚合器在全部终态后把全组结果注入上游岗的下一回合;声明 judge 时,initiator SHALL 为 `fleet:<舰队标识>:<judge 岗位标识>` 且 initiatorPreset 为 judge 岗 persona——聚合器 SHALL 自动以裁决者身份起一回合,其输入为全组目标产出。多轮辩论 SHALL 由裁决者在裁决回合内显式派发下一波(既有派发许可与护栏,深度界为硬防线);边的 rounds 声明 SHALL 为草稿呈现层的上界提示,系统 SHALL NOT 依其自动重入。

#### Scenario: 并行波与默认聚合

- **WHEN** 主编岗回合结束,有 fanout 边 targets=[撰稿A,撰稿B] aggregate=all
- **THEN** 两 manual 回合并行创建;两回合全部终态后,聚合器把两份产出注入主编会话的下一回合

#### Scenario: 裁决回合

- **WHEN** 同上但 aggregate={kind:"judge", judge:评审岗}
- **THEN** 波内任务 initiator 指向评审岗;全组终态后评审岗自动起回合,brief 含两份产出摘要

#### Scenario: 深度界拒绝波

- **WHEN** 链位递增后超过舰队声明 maxChainDepth 的扇出目标
- **THEN** 该目标不建任务,落 O1 事件留痕拒绝

#### Scenario: 多轮辩论为显式派发

- **WHEN** 裁决回合认为需要第二轮且舰队声明了相应派发许可
- **THEN** 第二波由裁决岗 dispatch_post 显式发起,护栏与深度界照常生效;系统不依 rounds 自动重入

#### Scenario: 上游失败如实入波

- **WHEN** 上游回合失败,fanout 出边照常触发
- **THEN** 波内 brief 含失败转述,不重试不吞错
