## Purpose

Defines how agents create and manage scheduled tasks themselves through MCP tools available to every persona preset, and how those operations appear to the user in the conversation.

## Requirements

### Requirement: Scheduling tools are available to all presets
Every agent preset SHALL have access to scheduling tools — create, list, pause, and delete — exposed through the cell's local MCP configuration. The tools SHALL operate only on the jobs of the cell they run in.

#### Scenario: Tool visible to an agent
- **WHEN** an agent lists its available tools
- **THEN** the four scheduling tools are present regardless of the active preset

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

### Requirement: Invalid schedules return structured errors
When the create tool receives an invalid cron expression or a past one-shot time, it SHALL return a structured error the agent can act on, and no job SHALL be created.

#### Scenario: Bad cron expression
- **WHEN** the create tool is called with cron `99 * * *`
- **THEN** the tool returns a validation error naming the expression
- **AND** no job is created

### Requirement: Job cards render in the conversation
A scheduling tool invocation SHALL render in the conversation as a job card — not raw tool output — showing the schedule (human-readable, with timezone), prompt summary, target agent, and current status. The card SHALL expose pause/resume and delete affordances whose effects reconcile with the job list.

#### Scenario: Card on creation
- **WHEN** the agent creates a job during a conversation
- **THEN** the tool invocation renders as a job card with schedule, timezone, agent, and status

#### Scenario: Pause from the card
- **WHEN** the user taps pause on a job card
- **THEN** the card reflects paused state and the job stops firing

### Requirement: List, pause, and delete through tools
The list tool SHALL return the caller-visible jobs with schedule, status, and last result, plus finite-run progress (executed/cap) when a cap is set. Pause and delete SHALL accept a job identifier and report success or a not-found error. An update tool SHALL accept a job identifier with changed name, prompt, schedule (any supported form), or max-runs, preserving the job id, execution history, and paused state, and SHALL report success or a not-found/invalid-schedule error. The tools SHALL NOT bypass the engine's queueing or binding semantics. Cluster-targeted jobs SHALL appear in the list with their cluster name and member count; pause, update, and delete apply to them like any job.

#### Scenario: Agent lists jobs
- **WHEN** the agent calls the list tool
- **THEN** all jobs in the cell are returned with id, schedule, timezone, status, and last outcome

#### Scenario: Cluster job in the list
- **WHEN** the agent calls the list tool while a cluster-targeted job exists
- **THEN** that entry shows the cluster name and member count alongside id, schedule, status, and last outcome

#### Scenario: Agent updates a schedule in place
- **WHEN** the agent calls the update tool to move a job to every-6-hours and raise its prompt
- **THEN** the same job id reflects the new schedule and prompt with its history rows intact

### Requirement: Create accepts the extended schedule forms
The create tool SHALL accept, alongside the existing cron/absolute-one-shot forms: a relative delay in whole minutes for one-shots (server anchors the clock; the tool description SHALL steer agents away from computing wall times themselves), an every-N interval (number 1–200 with a unit enum), and a maximum run count for recurring jobs. Values outside these shapes SHALL return the existing structured invalid-schedule error.

#### Scenario: Agent schedules with a relative delay
- **WHEN** the user tells the agent「20 分钟后提醒我喝水」and the agent calls create with delay=20 minutes
- **THEN** the job is created as a one-shot anchored to server now+20 minutes, and the reply states the resolved wall time

#### Scenario: Agent creates a capped interval job
- **WHEN** the agent calls create with interval every 2 hours and max-runs 5
- **THEN** the job fires 5 times two hours apart and then reports completed
