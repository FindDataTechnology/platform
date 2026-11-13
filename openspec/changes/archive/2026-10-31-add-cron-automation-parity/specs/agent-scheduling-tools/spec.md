# agent-scheduling-tools Specification (delta)

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Create accepts the extended schedule forms
The create tool SHALL accept, alongside the existing cron/absolute-one-shot forms: a relative delay in whole minutes for one-shots (server anchors the clock; the tool description SHALL steer agents away from computing wall times themselves), an every-N interval (number 1–200 with a unit enum), and a maximum run count for recurring jobs. Values outside these shapes SHALL return the existing structured invalid-schedule error.

#### Scenario: Agent schedules with a relative delay
- **WHEN** the user tells the agent「20 分钟后提醒我喝水」and the agent calls create with delay=20 minutes
- **THEN** the job is created as a one-shot anchored to server now+20 minutes, and the reply states the resolved wall time

#### Scenario: Agent creates a capped interval job
- **WHEN** the agent calls create with interval every 2 hours and max-runs 5
- **THEN** the job fires 5 times two hours apart and then reports completed
