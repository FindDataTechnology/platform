# cell-lifecycle Specification（delta）

## ADDED Requirements

### Requirement: 崩溃与启动失败必须持久可查

非预期退出（进程在自己没被要求停下时退出）与启动失败（进程起来了但没能在超时内监听端口）
SHALL 各自在 cell 台账上累计计数并保存最近一次现场；现场 SHALL 至少包含退出码或信号、
发生时间与该次运行时长。只有运维或策略主动停止（`stopping`）与演示 cell 的清理 SHALL NOT
计入崩溃计数。台账 SHALL 在进程重启后仍能回答「这个 cell 崩过几次、最后一次因为什么」。

#### Scenario: 未预期退出被计数且保留现场

- **WHEN** 一个运行中的 cell 进程以非零退出码或信号退出，且它并未被要求停止
- **THEN** 该 cell 的崩溃计数加一，并保存含退出码/信号、时间与运行时长的最近现场
- **AND** 台账在 gateway 重启后仍能读出这两个值

#### Scenario: 主动停止不计入崩溃

- **WHEN** 运维驱逐、空闲回收或滚版导致 cell 以 `stopping` 状态退出
- **THEN** 崩溃计数保持不变

#### Scenario: 启动失败与跑着崩分开计

- **WHEN** 一个 cell 进程启动后在超时内没有监听端口
- **THEN** 启动失败计数加一，崩溃计数不因此增加
- **AND** 两者在观测面上分别可见

#### Scenario: 崩溃不改持有关系

- **WHEN** 一个 cell 崩溃
- **THEN** 该 cell 的 owner 绑定、策略与排期任务保持不变
- **AND** 不写入 destroy 墓碑，下一次需求仍可正常唤醒

### Requirement: 崩溃重试必须有界但不锁人

同一 cell 在短窗口内反复崩溃时，系统 SHALL 让后续唤醒的进程启动退避随崩溃次数增长，
并 SHALL 在观测面与日志上明确标注该 cell 处于反复崩溃状态。系统 SHALL NOT 因崩溃次数
而永久拒绝唤醒该 cell —— 拒绝会让用户失去自己的数据面，且无法自愈。

#### Scenario: 反复崩溃触发退避

- **WHEN** 同一 cell 在窗口内连续崩溃多次
- **THEN** 下一次唤醒的进程启动被延迟，且延迟随崩溃次数增长
- **AND** 日志与观测面标注该 cell 反复崩溃

#### Scenario: 退避不阻断恢复

- **WHEN** 用户在被退避的 cell 上再次发起请求
- **THEN** 该 cell 仍会被唤醒（在退避延迟之后），而不是被永久拒绝
- **AND** 一旦连续正常运行超过康复窗口，崩溃计数归零而最近现场保留

### Requirement: 崩溃与拒醒进既有观测面

内存面（`/api/monitoring/memory`）的 cell 行 SHALL 暴露崩溃计数与最近现场；健康面
（`/healthz`）SHALL 暴露处于错误态的 cell 数量。唤醒准入被拒的记录 SHALL 与崩溃信息
一样可从台账读出，使「拒醒了几次、之后有没有醒来」无需 grep 日志。

#### Scenario: 内存面带出崩溃字段

- **WHEN** 运维读取内存面
- **THEN** 每个 cell 行含崩溃计数与最近现场（无崩溃时缺省或为零）

#### Scenario: 健康面带出错误态计数

- **WHEN** 有 cell 处于错误态
- **THEN** `/healthz` 的返回里能看到该数量，且不影响健康面本身的 200
