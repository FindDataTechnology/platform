## Purpose

The unified in-cell task engine: one task concept for all unattended agent work — a task targets a persona, runs in its own session, fires by a trigger, and carries an explicit lifecycle. Scheduled tasks are tasks with a schedule trigger; the engine owns execution (slots, serialization, restart semantics), while trigger kinds own when to fire.

## ADDED Requirements

### Requirement: A task is the unit of work given to a persona
Every task SHALL carry a target (`{ type, ref }` — the persona that executes it), a prompt, and a dedicated session that receives its output, created no later than its first execution and visible in the normal session list with a title derived from the task. Every task SHALL carry exactly one trigger kind; a schedule trigger's firing semantics are defined by `cron-module`. Creation SHALL reject a target whose `type` is not supported by the cell, and the persona type SHALL be supported.

#### Scenario: A scheduled task is a task with a schedule trigger
- **WHEN** a recurring job is created through the scheduling surface
- **THEN** the result is a task whose trigger is a schedule, target is the chosen persona, and whose executions land in the task's dedicated session

#### Scenario: Dedicated session appears in the session list
- **WHEN** a task is created
- **THEN** the system SHALL associate it with a session dedicated to that task, created no later than its first execution
- **AND** that session SHALL appear in the normal session list with a title derived from the task

#### Scenario: Unsupported target type is rejected
- **WHEN** a task is created with a target of an unsupported `type`
- **THEN** creation SHALL fail with a structured error and no task SHALL exist

### Requirement: Task lifecycle is explicit
Each execution of a task SHALL hold one lifecycle state: `queued`, `running`, or an outcome of `done`, `failed`, or `interrupted`. A failed execution SHALL record the error's gist. The engine SHALL NOT retry a failed or interrupted execution automatically.

#### Scenario: Completion is recorded
- **WHEN** a task's turn finishes successfully
- **THEN** the execution SHALL end in `done` with its duration recorded

#### Scenario: Failure carries the error gist
- **WHEN** a task's turn ends in an LLM or runtime error
- **THEN** the execution SHALL end in `failed` with a human-readable error gist persisted on the task

### Requirement: Tasks survive cell restarts
Task records SHALL be persisted atomically, such that a crash mid-write cannot corrupt previously stored tasks. On cell start, executions that were `queued` SHALL resume (run exactly once), and executions that were `running` SHALL be marked `interrupted` without re-executing. Trigger-level downtime semantics (missed occurrences, expired one-shots) remain `cron-module`'s.

#### Scenario: Queued execution resumes after restart
- **WHEN** the cell restarts while an execution is queued
- **THEN** that execution SHALL run after the cell is ready, exactly once

#### Scenario: Running execution is marked interrupted
- **WHEN** the cell restarts while an execution is running
- **THEN** the execution SHALL be marked `interrupted` at load
- **AND** SHALL NOT execute again without an explicit re-run

#### Scenario: Atomic persistence
- **WHEN** a task mutation is persisted
- **THEN** the storage write SHALL be atomic, such that a crash mid-write cannot corrupt previously stored tasks

### Requirement: Failed or interrupted tasks can be re-run manually
A re-run request SHALL enqueue a fresh execution of the same task — same target, prompt, and dedicated session — preserving prior executions' outcomes in history. Re-run SHALL be available for `failed` and `interrupted` executions and behave like run-now for any task.

#### Scenario: Re-run a failed task
- **WHEN** the user requests a re-run of a task whose last execution failed
- **THEN** a new execution is queued on the same task and session
- **AND** the failed execution remains in the task's history

### Requirement: Execution history is tracked per execution
The engine SHALL track, per task, last run and (for schedule-triggered tasks) next run, and a per-execution history of outcome and duration, pruned to a bounded number of entries.

#### Scenario: History records each execution's outcome
- **WHEN** an execution finishes
- **THEN** its timestamp, duration, and outcome SHALL be recorded on the task

#### Scenario: History is bounded
- **WHEN** a task accumulates more than 100 history entries
- **THEN** the oldest entries SHALL be dropped, keeping the 100 most recent

### Requirement: Executions run on execution slots
The engine SHALL dispatch executions to execution slots. A cell SHALL have exactly one interactive primary slot; the primary-slot policy SHALL be serial: an execution waits for any turn streaming in the cell rather than skipping or overlapping, simultaneous executions run one at a time in a deterministic order, and before prompting, the runtime is switched to the execution's target persona — waiting for any in-flight turn and runtime mutation, informing connected clients through the agent-change event, and leaving the runtime on that persona afterwards. Further slot kinds MAY be defined by other capabilities without changing the task model.

#### Scenario: Execution waits for a streaming turn
- **WHEN** an execution is due while a turn is streaming in any session of the cell
- **THEN** the execution SHALL wait for the turn to complete
- **AND** then run exactly once

#### Scenario: Simultaneous executions run sequentially
- **WHEN** multiple executions are due at the same time
- **THEN** they SHALL execute one at a time in a deterministic order
- **AND** SHALL NOT run concurrently

#### Scenario: Persona drift switches the runtime
- **WHEN** an execution of a task targeting persona P is due while the runtime is on persona Q
- **THEN** the runtime SHALL switch to P before the prompt is delivered
- **AND** after the execution the runtime SHALL remain on P
- **AND** connected clients SHALL receive the agent-change event naming P

#### Scenario: No switch when the persona already matches
- **WHEN** an execution is due while the runtime is already on the target persona
- **THEN** no runtime restart SHALL occur for persona reasons

### Requirement: Task lifecycle changes are broadcast
Task lifecycle changes — created, enqueued, started, finished (with outcome), interrupted — SHALL be broadcast to connected clients so client stores maintain live task state, using the existing job/task event surface (`cron_*` event types).

#### Scenario: Client sees an execution finish
- **WHEN** an execution finishes while a client is connected
- **THEN** the client SHALL receive an event carrying the task identifier and outcome
