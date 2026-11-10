## Purpose

The unified in-cell task engine: one task concept for all unattended agent work — a task targets a persona, runs in its own session, fires by a trigger, and carries an explicit lifecycle. Scheduled tasks are tasks with a schedule trigger; the engine owns execution (slots, serialization, restart semantics), while trigger kinds own when to fire.

## Requirements

### Requirement: A task is the unit of work given to a persona
Every task SHALL carry a target (`{ type, ref }` — the executor), a prompt, and a dedicated session that receives its output, created no later than its first execution and visible in the normal session list with a title derived from the task. Every task SHALL carry exactly one trigger kind; a schedule trigger's firing semantics are defined by `cron-module`. Supported target types are `persona` (a persona of this cell) and, when the cell's catalog holds online a2a entries, `a2a` (a market Agent Service, executed as a remote task — openspec: agent-delegation-a2a; an a2a execution occupies no persona slot and switches no runtime). Creation SHALL reject a target whose `type` is not supported by the cell or whose `ref` the cell cannot resolve, and the persona type SHALL be supported.

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

#### Scenario: An a2a target is a first-class task

- **WHEN** a task is created with target `{type: "a2a", ref}` naming a catalog a2a entry
- **THEN** the task exists under the same model — dedicated session, history, lifecycle — and its executions run as remote turns that neither switch nor occupy the cell's runtime persona

### Requirement: Manual trigger executes immediately
A task with trigger `manual` SHALL be enqueued for execution at creation — no schedule is attached, and the engine's serial primary-slot policy applies unchanged. Schedule-side lifecycle SHALL NOT apply to manual tasks (no paused, expired, or completed schedule states); re-run of a terminal execution SHALL remain available. Schedule-triggered semantics are untouched.

#### Scenario: Manual task executes on creation
- **WHEN** a task is created with trigger `manual`
- **THEN** an execution is enqueued immediately and runs under the serial policy

#### Scenario: No schedule-side states on manual tasks
- **WHEN** a manual task's execution is terminal
- **THEN** the task carries the execution lifecycle state (done, failed, or interrupted) and no schedule status beyond its absence of a schedule

#### Scenario: Re-run a manual task
- **WHEN** the user requests a re-run of a manual task whose execution ended failed
- **THEN** a fresh execution is enqueued on the same task and dedicated session

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
The engine SHALL dispatch executions to execution slots. A cell SHALL have exactly one interactive primary slot; the primary-slot policy SHALL be serial: an execution waits for any turn streaming in the cell rather than skipping or overlapping, simultaneous executions run one at a time in a deterministic order decided when the next execution is dequeued — an execution stamped `humanPriority` SHALL be dequeued ahead of executions that have NOT started yet, every other execution SHALL be dequeued in arrival order, arrival order SHALL be kept among `humanPriority` executions, and no execution SHALL preempt the one already running — and before prompting, the runtime is switched to the execution's target persona — waiting for any in-flight turn and runtime mutation, informing connected clients through the agent-change event, and leaving the runtime on that persona afterwards. This ordering SHALL hold whether or not worker slots exist: it belongs to the primary slot, not to the pool. When worker slots are available (see `worker-pool`), executions MAY be dispatched to a worker bound to the target persona instead — such executions run concurrently with each other and with the primary's interactive turn, never touch the primary runtime, and fire no agent-change event. Further slot kinds MAY be defined by other capabilities without changing the task model.

#### Scenario: Execution waits for a streaming turn
- **WHEN** an execution is due while a turn is streaming in any session of the cell
- **THEN** the execution SHALL wait for the turn to complete
- **AND** then run exactly once

#### Scenario: Simultaneous executions run sequentially
- **WHEN** multiple executions are due at the same time
- **THEN** they SHALL execute one at a time in a deterministic order
- **AND** SHALL NOT run concurrently

#### Scenario: 人优先唤醒越过未开始的排队执行
- **WHEN** 主槽链上已有一条执行在跑，其后排着若干已入队未开始的执行，此时一条 `humanPriority` 执行入队
- **THEN** 当前执行结束后 SHALL 先执行该 `humanPriority` 执行
- **AND** 其余排队执行 SHALL 随后按到达顺序执行
- **AND** 该 `humanPriority` 执行 SHALL NOT 与正在跑的并发

#### Scenario: 人优先之间保持到达顺序
- **WHEN** 两条 `humanPriority` 执行先后入队，其间还入队了普通执行
- **THEN** 两条人优先执行 SHALL 按其到达顺序先执行
- **AND** 普通执行 SHALL NOT 越过更早入队的人优先执行

#### Scenario: 池上限为 0 时排序仍生效
- **WHEN** `TASK_WORKER_MAX` 为 0（worker 池不注册）且主槽链存在排队积压
- **THEN** 上述人优先排序 SHALL 仍由主槽执行（不依赖 worker 池）

#### Scenario: Persona drift switches the runtime
- **WHEN** an execution of a task targeting persona P is due while the runtime is on persona Q
- **THEN** the runtime SHALL switch to P before the prompt is delivered
- **AND** after the execution the runtime SHALL remain on P
- **AND** connected clients SHALL receive the agent-change event naming P

#### Scenario: No switch when the persona already matches
- **WHEN** an execution is due while the runtime is already on the target persona
- **THEN** no runtime restart SHALL occur for persona reasons

#### Scenario: Worker dispatch bypasses the primary
- **WHEN** an execution is dispatched to a worker bound to its target persona
- **THEN** the primary runtime's persona and turn stream are untouched
- **AND** other dispatched executions may run concurrently with it

### Requirement: Task lifecycle changes are broadcast
Task lifecycle changes — created, enqueued, started, finished (with outcome), interrupted — SHALL be broadcast to connected clients so client stores maintain live task state, using the existing job/task event surface (`cron_*` event types).

#### Scenario: Client sees an execution finish
- **WHEN** an execution finishes while a client is connected
- **THEN** the client SHALL receive an event carrying the task identifier and outcome

### Requirement: The task engine exposes a read-only stats snapshot

The task engine SHALL expose a stats snapshot derived purely from its own store and execution
state: the count of scheduled tasks, executions by lifecycle state (at minimum running and
queued), the worker pool's occupancy (cap, busy, idle), and recent terminal-outcome counts.
The snapshot SHALL contain counts and identifiers only — never task prompts or other user
content — because it feeds platform-level telemetry. Sampling the snapshot SHALL have no side
effects on execution.

#### Scenario: The snapshot reports execution and worker-pool state

- **WHEN** one execution is running, two are queued, and the worker pool holds cap 4 with 1 busy
- **THEN** the stats snapshot reports those execution counts and `{cap: 4, busy: 1, idle: 3}`-shaped
  worker occupancy

#### Scenario: The snapshot carries no user content

- **WHEN** a scheduled task's prompt is set and executions entries exist
- **THEN** the snapshot's serialization contains no substring of that prompt

#### Scenario: The HTTP lane serves the snapshot under standard cell auth

- **WHEN** an authenticated request hits the cell's task stats endpoint
- **THEN** it answers the stats snapshot JSON; the route is NOT loopback-exempt

### Requirement: Out-of-window missed cron beats alert explicitly

When the task engine determines a scheduled beat was missed outside the catch-up tolerance window (the existing record-only path), the engine SHALL emit an explicit alert event (same channel discipline as the metering unconfigured alert) naming the task and miss count. Silent swallowing of out-of-window misses SHALL NOT occur: the miss record alone is not sufficient.

#### Scenario: Long outage loses beats and alerts

- **WHEN** a cell is stopped longer than the catch-up tolerance window and a recurring task misses beats
- **THEN** on boot the missed beats are recorded as today AND an alert event naming the task and count is emitted
