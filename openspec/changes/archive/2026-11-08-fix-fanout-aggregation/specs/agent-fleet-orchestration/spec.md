## MODIFIED Requirements

### Requirement: fanout 边以并行波执行且有界轮次成环

上游岗回合结束后,系统 SHALL 对其每条 fanout 出边执行一个并行波:为每个目标岗创建 manual 回合(深度按链位递增受 maxChainDepth 硬界,brief 含上游产出或失败的如实转述与轮次标注,与 handoff 同式;深度超界时 SHALL 不建任务并落结构化 O1 事件如实留痕)。聚合 SHALL 二式分流:无 judge 时,波内任务的 initiator SHALL 为上游回合会话——delegation 聚合器在全部终态后把全组结果注入上游岗的下一回合;声明 judge 时,initiator SHALL 为 `fleet:<舰队标识>:<judge 岗位标识>` 且 initiatorPreset 为 judge 岗 persona——聚合器 SHALL 自动以裁决者身份起一回合,其输入为全组目标产出。多轮辩论 SHALL 由裁决者在裁决回合内显式派发下一波(既有派发许可与护栏,深度界为硬防线);边的 rounds 声明 SHALL 为草稿呈现层的上界提示,系统 SHALL NOT 依其自动重入。

无论是否声明 judge,波内任务 SHALL 携带本波的聚合分组键(一条出边一次点火一个键,同波共用),使聚合以波为单位而非以会话为单位;无 judge 时波内任务 SHALL 另携带 initiatorPreset 为上游回合实际所用的人格,以裁决者身份起汇总回合的判据不因此变化。`origin.fleet.wave` SHALL 继续只作溯源标注,SHALL NOT 作为聚合分组键。

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

#### Scenario: 每波一个分组键

- **WHEN** 同一条 fanout 边先后点火两次
- **THEN** 两次创建的波内任务各自带一个分组键,两次的分组键不同,同一次波内所有任务共用同一个键

#### Scenario: 无 judge 波带发起人格

- **WHEN** fanout 边未声明 judge,上游回合在 persona X 下运行
- **THEN** 波内任务的 initiatorPreset 为 X,聚合器据此把上游会话摆回 X 再起汇总回合
