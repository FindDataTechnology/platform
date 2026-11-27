# cell-mcp-host Specification

## Purpose
把「只读 cell env」的那几个 MCP 卫星进程从一个 dsh runtime 一份，改成**一个 cell 一份宿主、
各 dsh 世代按 url 接入**，从而在每个 cell 有多个 runtime（主对话 bridge 与 worker 槽）时
省掉重复的卫星常驻内存。它同时规定边界：宿主失败不跨 cell、不改回合语义；成员级覆盖
（library/actions 等按人、按会话的开关）不经宿主下发；共享是否生效必须可观测。

## Requirements

### Requirement: 每 cell 一份 MCP 卫星宿主

同一 cell 的多份 dsh runtime（主对话 bridge 与各 worker 槽）SHALL 共用该 cell 的一份 MCP 卫星
宿主，而不是各自拉起一套卫星子进程。宿主 SHALL 以该 cell 的身份与凭据运行，SHALL NOT 接受
调用方声明的 cell 标识（同一 cell 内所有调用方本就同属该 cell，宿主无需也不得区分租户）。

#### Scenario: 一个 cell 开两个 worker 也只有一套卫星

- **WHEN** 一个 cell 同时运行主 bridge 与一个或多个 worker 槽
- **THEN** pod 内属于该 cell 的 MCP 卫星进程只存在一套
- **AND** 每个 dsh 世代都能正常列出并使用同一套工具

#### Scenario: 不开 worker 时形态不变

- **WHEN** 部署为 `TASK_WORKER_MAX=0`（单 dsh）
- **THEN** MCP 组合结果与变更前逐字节相同（stdio 条目、env 注入方式都不变）

### Requirement: 宿主失败不跨 cell、不改回合语义

宿主不可用时，该 cell 的 MCP 工具 SHALL 按 dsh 既有连接失败语义降级（记录原因、工具不可用），
SHALL NOT 影响其它 cell，SHALL NOT 中断该 cell 已在进行或后续的对话回合；宿主恢复后 SHALL
自动可用，无需重启该 cell。

#### Scenario: 宿主挂掉只影响本 cell 的工具面

- **WHEN** 某 cell 的卫星宿主崩溃
- **THEN** 该 cell 的 MCP 工具变灰并记录原因
- **AND** 其它 cell 的工具面不受影响，该 cell 的对话回合仍可进行

#### Scenario: 宿主恢复后自动可用

- **WHEN** 宿主重新起来
- **THEN** 该 cell 无需重启即可再次使用 MCP 工具

### Requirement: 成员级覆盖不从宿主下发

fd-memory 的成员令牌与 library 的成员集合 SHALL 继续按 worker 私有配置下发，SHALL NOT
因为宿主共享而放宽为「该 cell 的账号级视图」。

#### Scenario: 成员的记忆与书库范围不变

- **WHEN** 一个 worker 以某成员身份运行
- **THEN** 它能看到的记忆令牌与书库集合与该成员一致
- **AND** 不会因为共享宿主而看到该 cell 账号下的全部记忆或全部书库

### Requirement: 共享效果可观测

内存面 SHALL 能看出每个 cell 的 MCP 卫星进程数量，使「共享是否生效」不必靠 ps 手工核对。

#### Scenario: 面上一眼看出卫星数量

- **WHEN** 运维读取内存面
- **THEN** 每个 cell 行可读出其卫星进程数与总量
- **AND** 单 dsh 的 cell 与多 worker 的 cell 可直接对比
