# agent-scheduling-tools Specification (delta)

## MODIFIED Requirements

### Requirement: Agent-created jobs bind to the current preset and a dedicated session
A job created via the agent tool SHALL be bound to the preset the agent is running under and to a dedicated session for the job, following the engine's binding semantics. The tool SHALL return a confirmation payload carrying the job identifier, a human-readable schedule, the timezone applied, and the target session title. When the create tool is called with a `clusterId` (optionally `executionPolicy` and `targetAgents`), the job SHALL instead target that dynamic cluster — the cluster is resolved in the cell's cluster store, the preset binding does not apply, and the confirmation names the cluster, its member count, and the execution mode (openspec: scheduling-cluster-aware).

#### Scenario: Agent schedules a recurring report
- **WHEN** the user says "每天早上九点给我一份新闻汇总" and the agent calls the create tool with cron `0 9 * * *`, the prompt, and the client-provided timezone
- **THEN** a job is created bound to the current preset with a dedicated session
- **AND** the tool result describes the schedule in human-readable form

#### Scenario: Missing timezone defaults safely
- **WHEN** the create tool is called without a timezone
- **THEN** the job SHALL use the cell's local timezone and the tool result SHALL state which timezone was applied

#### Scenario: Agent schedules a cluster task

- **WHEN** the agent calls the create tool with a valid `clusterId` and a prompt
- **THEN** a cluster-targeted job is created and the tool result names the cluster, its member count, and whether members run sequentially or in parallel

### Requirement: List, pause, and delete through tools
The list tool SHALL return the caller-visible jobs with schedule, status, and last result. Pause and delete SHALL accept a job identifier and report success or a not-found error. The tools SHALL NOT bypass the engine's queueing or binding semantics. Cluster-targeted jobs SHALL appear in the list with their cluster name and member count; pause and delete apply to them like any job.

#### Scenario: Agent lists jobs
- **WHEN** the agent calls the list tool
- **THEN** all jobs in the cell are returned with id, schedule, timezone, status, and last outcome

#### Scenario: Cluster job in the list

- **WHEN** the agent calls the list tool while a cluster-targeted job exists
- **THEN** that entry shows the cluster name and member count alongside id, schedule, status, and last outcome
