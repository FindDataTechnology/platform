## ADDED Requirements

### Requirement: 每个 cell 的磁盘占用有可见预算

cell 的持久化数据（workspace 与会话历史）SHALL 有可查询的用量与上限，并在状态面如实呈现。
超过软阈值时 SHALL 提示用户；超过硬阈值时 SHALL 拒绝新的写入并给出可执行的处置建议，
SHALL NOT 以静默丢弃数据的方式腾空间。

一个 cell 的用量增长 SHALL NOT 使宿主节点的磁盘越过 kubelet 的驱逐阈值：预算必须在达到
节点阈值之前生效。

#### Scenario: 软阈值提示

- **WHEN** 某 cell 的 workspace 或会话历史超过软阈值
- **THEN** 该 cell 的状态面显示已用量与上限
- **AND** 该 cell 仍可正常读写

#### Scenario: 硬阈值拒绝写入而不是拖垮节点

- **WHEN** 某 cell 已达硬阈值仍尝试写入
- **THEN** 该次写入被拒绝并说明原因与处置方式
- **AND** 其他 cell 与该节点上的服务不受影响

#### Scenario: 平台可见每 cell 用量

- **WHEN** 运维查看容量面
- **THEN** 能看到每个 cell 的磁盘用量排序，识别出增长异常的租户
