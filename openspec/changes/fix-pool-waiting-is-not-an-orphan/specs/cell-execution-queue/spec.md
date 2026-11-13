## ADDED Requirements

### Requirement: 孤儿判定与清扫共用同一套认领语义

「queued 但不在执行链上」有多种成因，处置完全不同。引擎的两处判定——**周期清扫的重派**与**就绪面的
孤儿计数**——SHALL 共用同一套「在链上」谓词，MUST NOT 各自内联一份。

「在链上」SHALL 至少包含三种合法持有状态：在 `pendingExecutions` 中；是正在执行的那一条；
**已被并发池认领并在其等待队列中等待槽位**（池提供 `claims(id)` 判定）。

前三种 MUST NOT 被计为 `orphaned`，MUST NOT 使就绪面判定 `degraded`，MUST NOT 被周期清扫重派。
真孤儿（以上皆非）SHALL 照既有行为被计入并重派。池未注册（上限为 0）时，谓词 SHALL 退化为既有的
两种状态，行为与变更前逐字节一致。

#### Scenario: 池里等槽不计入孤儿

- **WHEN** 一条任务已被并发池认领并等待槽位，此刻它不在 `pendingExecutions`、也不是执行中的那一条
- **THEN** 就绪面的 `orphaned` SHALL NOT 计入它，`degraded` SHALL NOT 因此为 true
- **AND** 周期清扫 SHALL NOT 重派它（该半边已由 `1c003d38b` 实现，本规则要求两半一致）

#### Scenario: 真孤儿仍被计入并自愈

- **WHEN** 一条任务 `state=queued`，且不在 `pendingExecutions`、不是执行中、也未被池认领
- **THEN** 就绪面 SHALL 计入 `orphaned`，周期清扫 SHALL 照旧重派它——既有自愈行为逐字节不变

#### Scenario: 两个读点不会再次分叉

- **WHEN** 未来新增第三种持有状态（例如远程执行器持有）
- **THEN** 两处判定 SHALL 因为共用同一谓词而同时生效，MUST NOT 需要分别修改两处

#### Scenario: 池未启用时行为不变

- **WHEN** 池未注册（上限为 0，纯串行模式）
- **THEN** 谓词 SHALL 退化为 `pendingExecutions` + 执行中 id 两态，`orphaned` 与重派行为与变更前一致
