## MODIFIED Requirements

### Requirement: 只有没人点过的排期轮会被老化

队列驻留 SHALL 记录本次驻留的发起方：人工点火（`run now`）记为 `human`，排期/自动重排记为 `cadence`；
该标记 SHALL 与锚点一起持久化。老化策略 SHALL 只作用于 `cadence` 的排期轮：人工点火、
手工触发与事件触发的执行 SHALL 永不因队列年龄被丢弃。

#### Scenario: 人工 run-now 不被年龄上限丢掉

- **WHEN** 操作者对一条排期任务点 `run now`，该轮在队列里等待超过上限
- **THEN** 它仍然保留在队列中并最终真实开跑，SHALL NOT 被当作陈旧排期轮丢弃

#### Scenario: 排期轮仍然按上限让位

- **WHEN** 同一任务由排期自然触发且等待超过上限
- **THEN** 该轮按陈旧度被丢弃为 `skipped`，把执行槽让给更新的触发

#### Scenario: 深积压但仍在推进不算降级

- **WHEN** 某 cell 最老等待已达 60 分钟，但 30 秒前刚有一轮收口
- **THEN** 队列健康投影的 degraded 为假，并携带该推进时刻；探针不因「忙」而报不可用

#### Scenario: 深积压且停顿仍判降级

- **WHEN** 最老等待超过阈值，且整个窗口内没有任何执行收口
- **THEN** degraded 为真（原「假绿」事故的可检测性不变）

#### Scenario: 超预算回合始终降级

- **WHEN** 有回合运行超过自身预算加宽限
- **THEN** 无论是否刚有别的执行收口，degraded 均为真

