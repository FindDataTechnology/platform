## Purpose

Defines the in-cell scheduled-task engine: creating, persisting, and firing prompt jobs bound to a specific agent preset and session, with timezone-aware schedules and deterministic behavior around busy turns, runtime restarts, and downtime.

## ADDED Requirements

### Requirement: Jobs are bound to an agent preset and a session
Every job SHALL carry the agent preset it was created under and the session its output belongs to. Job execution SHALL deliver the job's prompt to the bound session, independent of which session the user last had open.

#### Scenario: Fires into the bound session
- **WHEN** a job bound to session S fires while the cell's active session is a different session T
- **THEN** the job's prompt SHALL be sent to session S
- **AND** the resulting turn SHALL be recorded under session S, not T

#### Scenario: Each job has a dedicated session
- **WHEN** a job is created
- **THEN** the system SHALL associate it with a session dedicated to that job, created no later than its first execution
- **AND** that session SHALL appear in the normal session list with a title derived from the job

### Requirement: Firing queues behind an active turn instead of skipping
When a job's scheduled time arrives while an agent turn is streaming, execution SHALL be deferred until the current turn completes, then proceed. It SHALL NOT be silently skipped.

#### Scenario: Job waits for a streaming turn
- **WHEN** a job fires while a turn is streaming in any session of the cell
- **THEN** the job execution SHALL wait for the turn to complete
- **AND** then run exactly once

#### Scenario: Simultaneous jobs run sequentially
- **WHEN** multiple jobs become due at the same time
- **THEN** they SHALL execute one at a time in a deterministic order
- **AND** SHALL NOT run concurrently

### Requirement: Firing under a different active preset switches the runtime
When a job fires while the cell runtime is running a different agent preset than the job's, the system SHALL switch the runtime to the job's preset before prompting, waiting for any in-flight turn and runtime mutation to finish. After the job completes, the runtime SHALL remain on the job's preset, and connected clients SHALL be informed of the effective preset change through the existing agent-change event.

#### Scenario: Overnight preset drift
- **WHEN** a job created under preset P fires while the runtime is on preset Q and no turn is streaming
- **THEN** the runtime SHALL switch to preset P before the job's prompt is sent
- **AND** after execution the runtime SHALL still be on preset P
- **AND** connected clients SHALL receive the agent-change event naming P

#### Scenario: No switch when preset already matches
- **WHEN** a job fires while the runtime is already on the job's preset
- **THEN** no runtime restart SHALL occur for preset reasons

### Requirement: Job scheduling API
The system SHALL support creating one-shot jobs (run once at a specific time) and recurring jobs (run on a cron schedule), each with a prompt and its preset/session binding. Job management operations — list, remove, pause, resume, and run-now — SHALL be available over the existing cell WebSocket surface using the existing `cron_*` message and event types.

#### Scenario: Create a recurring job
- **WHEN** a client sends a job-create request with a cron expression and a prompt
- **THEN** the system SHALL schedule the job and broadcast its status with an identifier, schedule, and next-run time

#### Scenario: Create a one-shot job
- **WHEN** a client sends a job-create request with an absolute time and a prompt
- **THEN** the system SHALL schedule the job to run once at that time

#### Scenario: Pause and resume
- **WHEN** a job is paused
- **THEN** its schedule SHALL stop firing until it is resumed
- **AND** on resume a recurring job SHALL continue from the next future occurrence

#### Scenario: Run now
- **WHEN** a run-now request is sent for a job
- **THEN** the job SHALL execute once immediately regardless of its schedule, without affecting future scheduled occurrences

### Requirement: Jobs persist across restarts
All jobs SHALL be persisted atomically and restored when the cell starts, with recurring jobs rescheduled automatically.

#### Scenario: Restore after restart
- **WHEN** the cell starts and persisted jobs exist
- **THEN** enabled recurring jobs SHALL be rescheduled
- **AND** one-shot jobs whose time has not passed SHALL remain scheduled

#### Scenario: Atomic persistence
- **WHEN** a job mutation is persisted
- **THEN** the storage write SHALL be atomic, such that a crash mid-write cannot corrupt previously stored jobs

### Requirement: Schedules are timezone-aware
A job MAY carry an IANA timezone identifier. When present, its cron schedule SHALL be evaluated in that timezone. When absent, the schedule SHALL be evaluated in the cell's local timezone.

#### Scenario: User timezone applies
- **WHEN** a job is created with cron `0 9 * * *` and timezone `Asia/Shanghai` on a cell running in UTC
- **THEN** the job SHALL fire at 09:00 Asia/Shanghai time

#### Scenario: Legacy job falls back to cell timezone
- **WHEN** a persisted job carries no timezone
- **THEN** its schedule SHALL be evaluated in the cell's local timezone, matching pre-change behavior

### Requirement: Downtime and expiry lifecycle
Recurring jobs whose occurrences passed entirely while the runtime was down SHALL NOT catch up; the gap SHALL be recorded on the job as a missed marker. One-shot jobs whose time passed while down SHALL be marked expired at load.

#### Scenario: Missed occurrences are not replayed
- **WHEN** a daily job's cell was down across one scheduled occurrence and starts afterwards
- **THEN** the missed occurrence SHALL NOT execute
- **AND** the job SHALL record a missed marker for it
- **AND** future occurrences SHALL fire normally

#### Scenario: One-shot expired during downtime
- **WHEN** the cell starts and a one-shot job's time is in the past
- **THEN** the job SHALL be marked expired without executing

### Requirement: Execution history is tracked
The system SHALL track per-job last run, next run, and execution history with success/failure and duration, pruned to a bounded number of entries.

#### Scenario: History records outcome
- **WHEN** a job execution finishes
- **THEN** its timestamp, duration, and success or failure SHALL be recorded on the job

#### Scenario: History is bounded
- **WHEN** a job accumulates more than 100 history entries
- **THEN** the oldest entries SHALL be dropped, keeping the 100 most recent

### Requirement: Job events are broadcast
Job lifecycle changes — created, updated, removed, fired, completed — SHALL be broadcast to connected clients using the existing `cron_*` event types, so client stores can maintain live job state.

#### Scenario: Client sees a job fire
- **WHEN** a job fires while a client is connected
- **THEN** the client SHALL receive fired and completed events carrying the job identifier and outcome
