## REMOVED Requirements

### Requirement: Jobs are bound to an agent preset and a session
**Reason**: Task identity (target, prompt, dedicated session) is engine-level and applies to every task, not only scheduled ones; keeping binding here would force every future trigger kind to restate it.
**Migration**: Superseded by `task-engine`'s "A task is the unit of work given to a persona" — both scenarios (fires into the bound session; dedicated session in the session list) are preserved there in task terms.

### Requirement: Firing queues behind an active turn instead of skipping
**Reason**: Queue-behind-turn is not a scheduling rule but the serial primary-slot execution policy, shared by all tasks regardless of trigger.
**Migration**: Superseded by `task-engine`'s "Executions run on execution slots" (wait-for-streaming-turn and sequential-deterministic scenarios).

### Requirement: Firing under a different active preset switches the runtime
**Reason**: Persona switching before prompting is likewise engine-level execution policy; expressing it per trigger kind would duplicate the invariant.
**Migration**: Superseded by `task-engine`'s "Executions run on execution slots" (persona-drift and no-switch scenarios, agent-change broadcast preserved).

### Requirement: Execution history is tracked
**Reason**: History is per execution of a task, must survive re-runs of the same task, and is engine state.
**Migration**: Superseded by `task-engine`'s "Execution history is tracked per execution" (same bounded-100 and outcome-recording semantics, restated for re-run).

### Requirement: Job events are broadcast
**Reason**: Lifecycle events now belong to tasks; scheduled tasks are tasks, so the broadcast requirement generalizes.
**Migration**: Superseded by `task-engine`'s "Task lifecycle changes are broadcast" — the `cron_*` event surface is preserved as the transport (see MODIFIED "Job scheduling API" for message-type continuity).

## MODIFIED Requirements

### Requirement: Job scheduling API
The system SHALL support creating one-shot tasks (run once at a specific time) and recurring tasks (run on a cron schedule) — tasks whose trigger is a schedule — each with a prompt and its target-persona/session binding carried by the task. Management operations — list, remove, pause, resume, and run-now — SHALL remain available over the existing cell WebSocket surface using the existing `cron_*` message and event types, operating on tasks with schedule triggers.

#### Scenario: Create a recurring job
- **WHEN** a client sends a job-create request with a cron expression and a prompt
- **THEN** the system SHALL create a task with a schedule trigger and broadcast its status with an identifier, schedule, and next-run time

#### Scenario: Create a one-shot job
- **WHEN** a client sends a job-create request with an absolute time and a prompt
- **THEN** the system SHALL create a task scheduled to run once at that time

#### Scenario: Pause and resume
- **WHEN** a task with a schedule trigger is paused
- **THEN** its schedule SHALL stop firing until it is resumed
- **AND** on resume a recurring task SHALL continue from the next future occurrence

#### Scenario: Run now
- **WHEN** a run-now request is sent for a task
- **THEN** the task SHALL execute once immediately regardless of its schedule, without affecting future scheduled occurrences

### Requirement: Jobs persist across restarts
All tasks with schedule triggers SHALL be persisted atomically with the engine's task records and restored when the cell starts, with recurring schedules rescheduled automatically; execution-level restart semantics (queued resumes, running becomes interrupted) are the engine's.

#### Scenario: Restore after restart
- **WHEN** the cell starts and persisted schedule-triggered tasks exist
- **THEN** enabled recurring schedules SHALL be rescheduled
- **AND** one-shot schedules whose time has not passed SHALL remain scheduled

#### Scenario: Atomic persistence
- **WHEN** a task or schedule mutation is persisted
- **THEN** the storage write SHALL be atomic, such that a crash mid-write cannot corrupt previously stored tasks

### Requirement: Downtime and expiry lifecycle
Recurring schedules whose occurrences passed entirely while the runtime was down SHALL NOT catch up; the gap SHALL be recorded on the task as a missed marker. One-shot schedules whose time passed while down SHALL mark their task expired at load.

#### Scenario: Missed occurrences are not replayed
- **WHEN** a daily task's cell was down across one scheduled occurrence and starts afterwards
- **THEN** the missed occurrence SHALL NOT execute
- **AND** the task SHALL record a missed marker for it
- **AND** future occurrences SHALL fire normally

#### Scenario: One-shot expired during downtime
- **WHEN** the cell starts and a one-shot task's time is in the past
- **THEN** the task SHALL be marked expired without executing
