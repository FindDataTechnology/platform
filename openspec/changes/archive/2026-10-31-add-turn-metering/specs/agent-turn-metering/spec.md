## Purpose

定时车道回合的细粒度计量面：每一回合的身份维度、token 细分与时相三段随回合结果事件同缝落列，
并按日永久汇总——给承载升降（切片⑤）与自迭代提案器（切片⑥）提供证据源，给成本优化提供尺子。

## ADDED Requirements

### Requirement: 每回合计量随回合结果事件同缝落列

每次舰队成员回合落回合结果事件时，系统 SHALL 同缝写入计量列（同一行、同一事务性 append，
不建第二套事件流）：身份维度 `preset_id`、`preset_source`（catalog|custom|shipped 或空）、
`provider`、`effort`、`carrier`（cell|worker|remote）、`carrier_instance`、`lane_id`（v1 计费
归因=模型车道 id）、`depth`、`wave`；usage 细分 `usage_cached_input`、`usage_cache_write`、
`usage_reasoning`。聚合字段 SHALL 成列并建索引，SHALL NOT 只写 detail JSON（detail 按行读
不按列查）。某维度不适用或运行时未报时 SHALL 落 NULL（诚实空缺），MUST NOT 填 0 或估算值
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
