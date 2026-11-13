## MODIFIED Requirements

### Requirement: Cluster task listing and management

The task list (client shape, the `cron_jobs` message, and the agent-facing `cron_list` tool) SHALL show cluster tasks with their cluster name and member count; the agent-facing `cron_list` tool SHALL be SCOPED and PAGED: by default it lists the operator's own tasks only (`scope=user`), with `scope=fleet` for fleet-materialized cadence tasks and `scope=all` for an audit. Every response's header SHALL state the counts for ALL scopes and which slice is shown — a scoped or paged page SHALL NOT read as the complete list. The page SHALL be bounded (default 30, ceiling 200) and SHALL print the next offset while more remain. the agent-facing `cron_create` tool SHALL describe a created cluster task with its cluster and execution mode. The tasks page SHALL render a cluster badge (name × member count) on cluster tasks and, when the task names a member subset, a per-member affordance that opens that member's sub-session. Pause, resume, re-run, and delete SHALL work on cluster tasks through the existing task-level operations; no cluster-scoped task endpoints are introduced. The worker pool SHALL never claim a cluster task — its target ref is a cluster id, not a persona — so cluster tasks always run on the primary chain. Creation and run-now before the task engine has initialized (a cold cell) SHALL be refused with a retry hint rather than executed without an executor.

#### Scenario: Cluster task in the list

- **WHEN** the agent calls the list tool while a cluster task exists
- **THEN** the entry shows the cluster name and member count alongside the usual fields

#### Scenario: Member sub-session reachable from the task card

- **WHEN** a user opens the tasks page for a completed cluster task created with `targetAgents`
- **THEN** the card shows the cluster badge and a per-member affordance that opens the member's sub-session

#### Scenario: Cold cell refuses instead of failing

- **WHEN** a task is created and run before the cell's task engine has finished initializing
- **THEN** the call is refused with a retry hint and no execution is attempted without an executor

#### Scenario: 默认只列操作者任务并声明被排除量

- **WHEN** 一个 cell 有 774 个定时任务，其中 658 个是舰队岗位物化的节奏任务，agent 调用 `cron_list`
- **THEN** 默认返回至多 30 条操作者任务，头部写明「774 total: 116 operator, 658 fleet-materialized — showing 1-30 of 116（next offset 30）」

#### Scenario: 显式查看舰队任务与全量

- **WHEN** 以 scope=fleet 调用
- **THEN** 只返回舰队物化任务；以 scope=all 调用则返回两者并给出同一份计数口径

#### Scenario: 页尾不冒充全量

- **WHEN** 池中 116 条而 offset=500
- **THEN** 返回空页但头部仍写明「showing none of 116」，不静默给空数组

