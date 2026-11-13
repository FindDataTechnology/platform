# worker-pool Specification（delta）

## MODIFIED Requirements

### Requirement: Workers live inside the cell

Worker runtimes SHALL share the cell's composed profile (home, patches, credentials) and execute
with session ids scoped to their tasks; all worker state stays inside the cell's data directory and
is never observable from another cell. A worker crash restarts with backoff (the bridge's own
lifecycle) without affecting the primary runtime or other workers. A worker SHALL NOT bring its own
copy of the cell's MCP satellite processes: it SHALL attach to the cell's shared MCP host, so adding
a slot adds one dsh runtime and no satellites. With `TASK_WORKER_MAX=0` the composed shape SHALL stay
byte-for-byte unchanged.

#### Scenario: Worker crash is contained
- **WHEN** a worker's runtime exits unexpectedly mid-task
- **THEN** its task records a failed or interrupted execution and the primary runtime and other workers are unaffected

#### Scenario: 加一个槽不再加一套卫星

- **WHEN** 部署把 `TASK_WORKER_MAX` 从 0 调到 1 并触发一个 persona 任务
- **THEN** 该 cell 只新增一个 dsh runtime，卫星进程数保持不变
- **AND** 该槽的工具面与主 bridge 一致

#### Scenario: 槽内回合隔离不受影响

- **WHEN** 主 bridge 与 worker 槽同时有回合在跑
- **THEN** 两个回合各自的上下文仍互不可见（进程级隔离未变）

#### Scenario: 单 dsh 部署不受影响

- **WHEN** 部署为 `TASK_WORKER_MAX=0`
- **THEN** 组合出的 MCP 条目与运行时形态与变更前逐字节相同
