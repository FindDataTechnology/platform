## MODIFIED Requirements

### Requirement: 舰队以 orchestration 声明段描述编导边与约束

舰队对象 SHALL 支持可选 `orchestration` 段:`edges`(边集)与 `constraints`(spanMax / budgetPerEdgeMin / maxChainDepth,均可缺省取默认)。边 SHALL 为六种之一:`trigger`(cron 触发某岗,= 既有节奏物化的图形态,行为不变)、`report`(报数上行,**由组织树派生**:系统 SHALL 为每个声明了上级的岗位生成一条 `from`=该岗、`to`=其上级的 report 边,读时计算不改运行行为;写面 SHALL 只接受与该树一致的声明并 SHALL 拒绝与之矛盾的声明,读面 SHALL NOT 把同一条边呈现两次)、`dispatch`(运行期由岗位发起的派活许可)、`handoff`(上游岗回合完成后接棒下游岗)、`fanout`(上游岗回合完成后并行扇出至多岗并按聚合式汇流)、`event`(外部信号源唤醒某岗)。每条边 SHALL 显式引用本舰岗位 ref(event 边的 from SHALL 为 `bot:<botId>` 形式的外部信号源名,存在性由运行期如实判定);系统 SHALL NOT 按建队顺序或任何隐式规则推断边。写面 SHALL 全量校验:边引用的岗位存在、handoff 子图无环、每条 handoff 链长 ≤ maxChainDepth、span ≤ spanMax(警告级)。event 边的 to SHALL 为 persona/a2a 岗(cluster 无 manual 车道、tool 的参数是逐跳 args,均结构化拒绝);event 边 SHALL NOT 参与 DAG 环检测。未声明 orchestration 段或声明为 `schedule` 模式时,系统行为 SHALL 与现状逐字节一致。

**编导随模板下发**：orchestration 段 SHALL 可作为 pack 舰队模板的组成部分下发——发布预校验与实例化建队 SHALL 复用与写面同一校验器（以模板成员集为岗位域）；由模板落地的编导与手写编导在运行时 SHALL 无差异，主人的后续改写走既有写面。模板编导不改变本条的任何护栏语义。

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

#### Scenario: 模板编导与手写无差异

- **WHEN** 两支结构相同的舰队，一支的 orchestration 来自模板下发、一支由主人手写
- **THEN** 二者的边展开、派发许可、接棒与唤醒行为完全一致

#### Scenario: 报数边随组织树出现

- **WHEN** 舰队有岗位 A 与直属下级 B,且未声明任何 report 边
- **THEN** 编导读面出现一条 `from=B, to=A` 的 report 边(标注为派生),SHALL NOT 要求主人手写

#### Scenario: 与树矛盾的报数声明被拒

- **WHEN** B 的直属上级是 A,而声明段写了 `report: B→C`
- **THEN** 写面结构化拒绝并指名"B 报给 A,不是 C",SHALL NOT 落库

#### Scenario: 一致声明不重复呈现

- **WHEN** 声明段已写 `report: B→A` 且 B 的上级确实是 A
- **THEN** 校验通过,读面上这条边只出现一次(保留声明形态,不再叠一条派生边)

