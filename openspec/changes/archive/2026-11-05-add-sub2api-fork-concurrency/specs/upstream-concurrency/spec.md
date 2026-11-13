# add-sub2api-fork-concurrency Specification

## ADDED Requirements

### Requirement: 上游账号有界排队与快速拒绝

sub2api 网关 SHALL 对每个上游账号维护有界并发信号量（默认上限 `UPSTREAM_CONCURRENCY_MAX=8`）与有界等待队列（默认 `UPSTREAM_QUEUE_BOUND=32`）；队列满时 SHALL 立即返回 `429 queue_full`（携 `Retry-After` 头），SHALL NOT 无界排队吞没客户端超时。

#### Scenario: 队列满快速拒

- **WHEN** 某上游账号的等待队列已达 bound
- **THEN** 新请求立即得 `429 queue_full` + `Retry-After`，全程 <100ms，不入队

#### Scenario: 故障窗口零吞超时

- **WHEN** 上游持续 5xx（故障窗口内）
- **THEN** 客户端全部得到快速响应（快速拒或快速失败），无请求吞到客户端超时

### Requirement: AIMD 自适应并发

sub2api 网关 SHALL 按 AIMD（加性增/乘性减）自适应调节每账号并发窗口：成功 +1（至 max）、5xx/超时减半（至 1）；连续 N 次上游失败 SHALL 打开键控熔断（open），冷却后半开探测，探测成功恢复。`UPSTREAM_AIMD_ENABLED=false` 时 SHALL 回退静态并发（旧行为），有界队列仍生效。

#### Scenario: 状态机全转移

- **WHEN** 上游经历 success/5xx/timeout/熔断 open/半开探测 成败各情形
- **THEN** 并发窗口与熔断状态按 AIMD 规则精确转移（单测钉死全转移）

#### Scenario: 一键回退

- **WHEN** `UPSTREAM_AIMD_ENABLED=false`
- **THEN** 并发窗口固定 max，熔断关闭，仅有界队列与快速拒生效

### Requirement: 队列与 AIMD 可观测

sub2api 网关 SHALL 暴露 `upstream_queue_depth`/`upstream_queue_rejected_total`/`upstream_aimd_concurrency` 三指标；channel_monitor 的 duration 哨兵 SHALL 收编为读 AIMD 真状态（非 SQL 猜形）。

#### Scenario: 哨兵读真状态

- **WHEN** channel_monitor 巡检
- **THEN** 哨兵读每账号 aimd_state/queue_depth 实时值，假哨兵（SQL 猜形）退役
