## ADDED Requirements

### Requirement: 成本读面按岗位、run 与边三切面

系统 SHALL 暴露每回合的成本估算（USD），并 SHALL 支持三个切面：按岗位（既有日汇总口径）、按 run、按边（两岗位之间的 hop）。任一切面的金额 SHALL 来自各回合**回合时**记下的估算分量之和，SHALL NOT 以当下价目重算历史回合（重算会改写历史）。每个金额 SHALL 同时给出样本量（已定价回合数）与该批回合的价目版本戳，使读者能分辨「样本小」与「确实便宜」。

未定价的回合 SHALL NOT 贡献金额，SHALL NOT 以 0 冒充观测：整组回合都未定价时，该组的金额 SHALL 为 `null`（诚实空缺），样本量为 0。金额 SHALL 明确标注为估算（estimate），SHALL NOT 被呈现为账单。

#### Scenario: 按 run 取金额

- **WHEN** 某 run 含两个已定价回合（0.25 与 0.75 USD）
- **THEN** 该 run 的金额为 1.00 USD，样本量为 2，并带价目版本戳

#### Scenario: 未定价回合不贡献且不冒充 0

- **WHEN** 某 run 两个回合中只有一个被定价
- **THEN** 金额只计已定价那个，样本量为 1（而非 2）；若两个都未定价，金额为 null 且样本量为 0

#### Scenario: 按边取金额

- **WHEN** 查询窗口内存在一条 handoff hop
- **THEN** 该 hop 的金额为其**下游回合**自身的估算之和；该 hop 无已定价回合时金额为 null

#### Scenario: 历史金额不被重算

- **WHEN** 价目表在回合发生后变更
- **THEN** 按 run/边取到的历史金额保持回合时的估算值，不随新价目变化

#### Scenario: 列表页不产生 N+1 查询

- **WHEN** 请求 run 列表（分页）
- **THEN** 整页金额由一次分组查询得出，逐条附带，且与单 run 详情读数一致

#### Scenario: 无已定价回合的空舰队

- **WHEN** 某舰队从未跑过已定价回合
- **THEN** 其花销读面的金额为 null、样本量为 0（不返回 0 元）

## MODIFIED Requirements

### Requirement: 每回合计量随回合结果事件同缝落列

每次舰队成员回合落回合结果事件时，系统 SHALL 同缝写入计量列（同一行、同一事务性 append，
不建第二套事件流）：身份维度 `preset_id`、`preset_source`（catalog|custom|shipped 或空）、
`provider`、`effort`、`carrier`（cell|worker|remote）、`carrier_instance`、`lane_id`（v1 计费
归因=模型车道 id）、`depth`、`wave`；usage 细分 `usage_cached_input`、`usage_cache_write`、
`usage_reasoning`。聚合字段 SHALL 成列并建索引，SHALL NOT 只写 detail JSON（detail 按行读
不按列查）。成本估算的四分量（输入/输出/缓存写/缓存读 USD）SHALL 同时落在回合行与日汇总行：
回合行的那一份是**按 run/按边归因**的唯一来源（日汇总的键没有 run 与边维度），两份数值
SHALL 由同一缝的同一输入产出、逐回合一致；未定价回合 SHALL 在两处都留空缺而非 0，金额
SHALL 始终是带价目版本戳的估算，MUST NOT 被当作账单。某维度不适用或运行时未报时 SHALL 落 NULL（诚实空缺），MUST NOT 填 0 或估算值
冒充观测。carrier SHALL 由执行载体决定：worker 槽认领的执行=worker（实例名随行）、a2a 远端
执行=remote、其余主链执行=cell；判定 SHALL 来自认领方写入的执行载体标记，MUST NOT 由
任务字段推断冒充。

#### Scenario: usage 细分如实落列

- **WHEN** 一个 persona 回合结束且运行时报告了 cacheReadTokens/cacheWriteTokens/reasoningTokens
- **THEN** 该回合事件行的三列分别落对应值，`usage_input` 保持上游语义（未缓存输入）
- **AND** 计费输入可由 input+cached_input+cache_write 三列之和读出

#### Scenario: 运行时未报则诚实空缺

- **WHEN** 运行时未报告 usage 或某细分字段
- **THEN** 对应列落 NULL 而非 0，聚合查询以「非 NULL 计数」呈现样本量

#### Scenario: worker 认领的执行落 worker 载体

- **WHEN** 一个 persona 任务被 worker 槽认领执行
- **THEN** 该回合事件行 carrier=worker 且 carrier_instance 为该 worker 实例标识
- **AND** 主链执行的同类回合 carrier=cell

#### Scenario: 成本分量同落两处且一致

- **WHEN** 一个已定价回合落事件
- **THEN** 该回合行与对应日汇总行的四个 USD 分量来自同一输入且数值一致
- **AND** 两处都带同一价目版本戳，未定价回合在两处都为空缺（非 0）
