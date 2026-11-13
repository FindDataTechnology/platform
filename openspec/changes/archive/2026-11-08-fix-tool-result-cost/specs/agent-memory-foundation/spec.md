## MODIFIED Requirements

### Requirement: agent 自我认知读面 memory_overview

MCP 面 SHALL 新增 `memory_overview` 工具：按调用者令牌的可达分区返回概览——各分区标识、页数、
最近写入时间与最近 N 条标题（N 有上限）；工具 SHALL 复用既有授权判定（deployment 见 own+shared、
pod 见 shared、person 见自有根，叠加 oversight 只读权），MUST NOT 越权披露不可达分区。工具 SHALL
零写副作用、遵守既有预算纪律（返回体有硬上限），不可达时按既有 fail-open 姿态返回结构化空集或错误。
该硬上限 SHALL 同时约束**两个维度**：分区条数与每分区的标题条数；两处任一被裁剪时返回体 SHALL 置 truncated 为真，并回带可达分区总数，SHALL NOT 以「分区数未超限」判为未截断而实际裁掉标题。

#### Scenario: 部署成员查看自己的记忆概览

- **WHEN** 以 `d/<packId>/<agentId>` 部署令牌调用 memory_overview
- **THEN** 返回 own 与 shared 两个分区的页数与最近条目，不含其他成员的私有分区

#### Scenario: pod 令牌无 own 分区

- **WHEN** 以 pod 令牌调用 memory_overview
- **THEN** 仅返回 shared 分区概览，无 own 字段（与既有分区语义一致）

#### Scenario: 标题被裁剪时也报截断

- **WHEN** 某 person 根只有 1 个可达分区，但该分区有 9 页而概览每分区只列 3 条标题
- **THEN** 返回体 truncated 为真（页数 9 > 已列标题 3），并回带 total_partitions

#### Scenario: 分区数超限时声明总量

- **WHEN** person 根有 40 个可达分区而概览上限为 25 个分区
- **THEN** 返回至多 25 个分区、total_partitions=40、truncated=true
