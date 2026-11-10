## Purpose

定时车道回合的细粒度计量面：每一回合的身份维度、token 细分与时相三段随回合结果事件同缝落列，
并按日永久汇总——给承载升降（切片⑤）与自迭代提案器（切片⑥）提供证据源，给成本优化提供尺子。

## Requirements

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

### Requirement: 回合时相三段计量

每回合 SHALL 计量三段时相并落列：`queue_wait_ms`（执行出队时刻减入队时刻；入队时刻
SHALL 在任务引擎唯一入队点 stamp，主链与 worker 槽共用）、`spin_up_ms`（persona 组合获取
的代价——会话驻留路径恒 0，遗留重启路径为实测切换耗时，无 preset 任务为 NULL）、
`ttft_ms`（首个 assistant 事件时刻减回合开始时刻）。采集 SHALL 在既有回合缝内完成，
SHALL NOT 引入第二条执行路径或额外轮询。

#### Scenario: 驻留路径零重启税

- **WHEN** 一个 persona 回合经会话驻留路径获取 persona（presetPath=parked）
- **THEN** 该回合 spin_up_ms=0
- **AND** 遗留回退路径的同类回合 spin_up_ms 为实测重启耗时（大于 0）

#### Scenario: 排队等待如实计量

- **WHEN** 一个任务入队后因串行链繁忙等待 W 毫秒才出队执行
- **THEN** 该回合 queue_wait_ms=W（±轮询粒度）；立即执行的回合 queue_wait_ms 近 0

#### Scenario: 首 token 时刻可查

- **WHEN** 一个回合收到首个 assistant 事件
- **THEN** ttft_ms 为该时刻相对回合开始的毫秒数；零产出回合该列 NULL

### Requirement: 日汇总永久保留且与明细同缝累积

系统 SHALL 维护日汇总表（键：fleet×member×carrier×provider×model×UTC 日），列含回合计数
（总/ok/failed/skipped）、五类 token 合计（input/cached_input/cache_write/reasoning/output）
与三段时相的 sum/max。每条回合事件落列时 SHALL 同缝 upsert 对应日行（增量累积）；日汇总
SHALL 永久保留，MUST NOT 随明细的滚动裁剪（每成员最近 N 条 + 保留窗）被删除或重置；汇总
SHALL 只增不改正史值（修正以新增行语义处理，MUST NOT 回抹历史日行）。

#### Scenario: 明细裁剪不影响汇总

- **WHEN** 某岗位的回合事件被滚动裁剪（超出最近 N 条且早于保留窗）
- **THEN** 该岗位历史各日的汇总行保持原值可查，长期趋势不受裁剪影响

#### Scenario: 同缝累积

- **WHEN** 一条回合事件落列
- **THEN** 其 (fleet, member, carrier, provider, model, day) 对应的日行各计数与 token/时相
  合计即时累加，无需离线批处理即反映最新回合

#### Scenario: 计量失败不阻塞回合

- **WHEN** 计量列或日汇总写入失败（表结构异常、磁盘错误等）
- **THEN** 回合结果事件本体仍按既有语义落库（或按其自身失败语义处理），回合执行不受影响
- **AND** 失败以计数/警告呈现，MUST NOT 向回合注入错误

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
