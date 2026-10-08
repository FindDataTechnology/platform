## Purpose

The cell's task-worker slots: on-demand dsh runtime instances, each pinned to one persona, that execute task-engine dispatches in parallel while the interactive primary runtime serves the conversation. Serial mode (cap 0) is exactly today's behavior — the pool is a pure widening of where executions run.

## Requirements

### Requirement: Workers spawn on demand with persona affinity
The pool SHALL execute a due task targeting persona P on an idle worker bound to P. When no such worker exists and the pool is under its cap, one SHALL be spawned for P; when the pool is at cap, the task SHALL queue until a slot frees. A worker SHALL keep its persona for its entire lifetime.

#### Scenario: Spawn on demand
- **WHEN** a task targeting persona P is due, no worker bound to P exists, and the pool is under cap
- **THEN** a worker is spawned bound to P and the task executes on it

#### Scenario: Reuse an idle same-persona worker
- **WHEN** a task targeting persona P is due and an idle worker bound to P exists
- **THEN** the task executes on that worker without spawning another

#### Scenario: Queue at cap
- **WHEN** a task is due, no matching idle worker exists, and the pool is at its cap
- **THEN** the task remains queued until a worker slot frees, and no worker is spawned

### Requirement: The pool is bounded and degrades gracefully
The pool size SHALL NOT exceed `TASK_WORKER_MAX`. At 0 the pool is inert — every execution runs on the primary slot with today's serial semantics (queue behind the active turn, persona switch before prompting). The value MAY be set per deployment; unset defaults to 0.

#### Scenario: Cap zero is today's serial behavior
- **WHEN** the cell runs with `TASK_WORKER_MAX=0`
- **THEN** task executions run on the primary slot exactly as before this capability, one at a time, queueing behind the live turn

#### Scenario: Cap is never exceeded
- **WHEN** many tasks for distinct personas are due simultaneously and the cap is N
- **THEN** at most N workers exist, and remaining tasks queue

### Requirement: Idle workers are reaped
A worker idle beyond the reap timeout (5 minutes) SHALL be shut down gracefully; a later task for its persona cold-starts a fresh worker. Busy workers are never reaped.

#### Scenario: Idle reap and cold start
- **WHEN** a worker has been idle for the reap timeout
- **THEN** it is shut down
- **AND** a subsequent task for its persona spawns a fresh worker

### Requirement: The primary runtime stays interactive
While at least one worker slot is available, task executions SHALL NOT run on the primary runtime — the interactive conversation is never blocked or restarted by a task. In serial mode (cap 0) the primary executes tasks under the existing queue-behind-turn policy.

#### Scenario: Conversation continues mid-fan-out
- **WHEN** delegated tasks are executing on workers and the user sends a chat prompt
- **THEN** the prompt runs on the primary runtime without waiting for the tasks

#### Scenario: No persona switch for worker executions
- **WHEN** a task targeting persona P executes on a worker bound to P
- **THEN** the primary runtime's persona is unchanged and no agent-change event fires for it

### Requirement: Worker lifecycle is observable
Worker spawn, reap, busy, and idle transitions SHALL be broadcast to connected clients on the existing event surface, carrying the worker's persona and state, so clients and ops views can see where executions run.

#### Scenario: Client sees the pool change
- **WHEN** a worker spawns or is reaped while a client is connected
- **THEN** the client receives a pool-state event naming the worker's persona and lifecycle change

### Requirement: Workers live inside the cell
Worker runtimes SHALL share the cell's composed profile (home, patches, credentials) and execute with session ids scoped to their tasks; all worker state stays inside the cell's data directory and is never observable from another cell. A worker crash restarts with backoff (the bridge's own lifecycle) without affecting the primary runtime or other workers.

#### Scenario: Worker crash is contained
- **WHEN** a worker's runtime exits unexpectedly mid-task
- **THEN** its task records a failed or interrupted execution and the primary runtime and other workers are unaffected
