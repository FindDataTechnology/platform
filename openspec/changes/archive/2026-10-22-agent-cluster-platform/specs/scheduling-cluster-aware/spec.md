# scheduling-cluster-aware Specification

## Purpose

Lets a scheduled task target a dynamic cluster instead of a single persona: the engine fans the prompt out to the cluster's members, aggregates their outputs into the task's bound session, and records what each member ran under. Execution semantics follow the runtime's real shape — one shared persona runtime, remote agents over A2A — and are stated honestly rather than as an idealized parallel engine.

## ADDED Requirements

### Requirement: Cluster task creation

Task creation (the `POST /api/cron` bridge, the `cron_add` WebSocket message, and the agent-facing `cron_create` tool) SHALL accept an optional `clusterId` with an optional `executionPolicy { allowParallel?: boolean; timeoutMinutes?: number (0, 1440]; resultAggregation?: "first" | "all" | "summary" }` and an optional non-empty `targetAgents: string[]` (member agent ids to run; default every member). A task MUST target either a preset or a cluster, never both. The creating surface SHALL resolve the cluster in the cell's cluster store (an unknown id is refused with 400 naming it) and stamp the task with `targetType: "cluster"`, the cluster id as its target ref, and `clusterName`/`agentCount` for list views; the policy shape is validated identically on every surface. These cluster fields SHALL be persisted with the task and survive a restart. The created task's client shape SHALL carry `clusterId`, `clusterName`, `agentCount`, `executionPolicy`, and `targetAgents`.

#### Scenario: Cluster task creation

- **WHEN** a caller creates a task with a valid `clusterId` and `targetAgents: ["finance-bot", "data-analyst"]`
- **THEN** a task is created whose target type is `cluster`, carrying the cluster name and member count

#### Scenario: Unknown cluster refused

- **WHEN** a caller creates a task with a `clusterId` that is not in the cell's cluster store
- **THEN** the request is refused with 400 naming the cluster

#### Scenario: Preset and cluster are exclusive

- **WHEN** a caller supplies both a preset and a `clusterId`
- **THEN** the request is refused

#### Scenario: Cluster fields survive a restart

- **WHEN** the cell restarts after a cluster task was created
- **THEN** the reloaded task still carries its cluster name, policy, and member subset

### Requirement: Cluster task execution and aggregation

When a cluster task fires, the engine SHALL resolve the cluster's members (optionally narrowed by `targetAgents`) against the live catalog: a member whose pack is uninstalled, whose entry is not chat/a2a, or whose local persona preset is not ready SHALL be skipped and reported by name. Each runnable member SHALL run the task prompt in its own sub-session `<bound-session>--<agent-id>` titled `<cluster> · <member>`: local persona members through the shared runtime (preset switch, one turn, collected reply) and a2a members as remote turns. Local persona members ALWAYS run sequentially — the runtime hosts one persona at a time; with `allowParallel: true` the a2a members' remote turns overlap the persona loop, and the aggregate SHALL note the sequential degradation when it applies. `timeoutMinutes` bounds each member turn. After the fan-out the runtime SHALL be restored to the preset it had before the task.

The task's bound session SHALL receive the prompt and one aggregate: `all` (default) lists every successful member's output under its name; `first` reports the first successful member's output; `summary` runs one synthesis turn in the bound session under the first successful persona member, fed with every member output, and records that turn exactly once (falling back to the `all` digest with a note when no local member succeeded or the synthesis failed). Members that failed or were skipped SHALL be listed with their reason. The execution SHALL succeed when at least one member succeeded and fail — naming every member's reason — when none did. The cluster's `totalExecutions`/`lastUsedAt` SHALL be updated, and the engine's history entry SHALL record `models: { <member name>: <model id> }` — the model the runtime served each member with (the deployment's lane is the single provider; the record names the model, not a provider layer).

#### Scenario: Sequential fan-out with aggregate

- **WHEN** a two-member cluster task runs with the default policy
- **THEN** each member's reply lands in its own sub-session, the bound session holds the prompt and an aggregate listing both outputs, and the task history records the model each member ran under

#### Scenario: Parallel policy is honest about local personas

- **WHEN** a cluster task with `allowParallel: true` has both local persona members and a2a members
- **THEN** the a2a turns run concurrently with the persona loop, the persona members still run one after another, and the aggregate notes the degradation

#### Scenario: Summary synthesis lands once

- **WHEN** a cluster task completes with `resultAggregation: "summary"` and at least one local member succeeded
- **THEN** the bound session holds the synthesis reply exactly once, led by the first successful persona member

#### Scenario: Partial failure still succeeds

- **WHEN** one member fails and another succeeds
- **THEN** the task succeeds, the aggregate names the failed member and its error, and the successful output is present

#### Scenario: Every member failed

- **WHEN** no member produces output
- **THEN** the task fails with an error naming every member's failure or skip reason

### Requirement: Cluster task listing and management

The task list (client shape, the `cron_jobs` message, and the agent-facing `cron_list` tool) SHALL show cluster tasks with their cluster name and member count; the agent-facing `cron_create` tool SHALL describe a created cluster task with its cluster and execution mode. The tasks page SHALL render a cluster badge (name × member count) on cluster tasks and, when the task names a member subset, a per-member affordance that opens that member's sub-session. Pause, resume, re-run, and delete SHALL work on cluster tasks through the existing task-level operations; no cluster-scoped task endpoints are introduced. The worker pool SHALL never claim a cluster task — its target ref is a cluster id, not a persona — so cluster tasks always run on the primary chain. Creation and run-now before the task engine has initialized (a cold cell) SHALL be refused with a retry hint rather than executed without an executor.

#### Scenario: Cluster task in the list

- **WHEN** the agent calls the list tool while a cluster task exists
- **THEN** the entry shows the cluster name and member count alongside the usual fields

#### Scenario: Member sub-session reachable from the task card

- **WHEN** a user opens the tasks page for a completed cluster task created with `targetAgents`
- **THEN** the card shows the cluster badge and a per-member affordance that opens the member's sub-session

#### Scenario: Cold cell refuses instead of failing

- **WHEN** a task is created and run before the cell's task engine has finished initializing
- **THEN** the call is refused with a retry hint and no execution is attempted without an executor
