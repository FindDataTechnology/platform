## Purpose

The cell's task-worker slots: on-demand dsh runtime instances, each pinned to one persona, that execute task-engine dispatches in parallel while the interactive primary runtime serves the conversation. Serial mode (cap 0) is exactly today's behavior — the pool is a pure widening of where executions run.

## Requirements

### Requirement: Workers spawn on demand with persona affinity
The pool SHALL execute a due task targeting persona P on an idle worker bound to P. When no such worker exists and the pool is under its cap, one SHALL be spawned for P; when the pool is at cap, the task SHALL queue until a slot frees. A worker SHALL keep its persona for its entire lifetime. A worker's turn SHALL be prompted under the SAME per-round child conversation id the primary chain derives (`roundChildSessionId`), never the stable mirror session id: the mirror id stays the transcript/sidebar id, while the runtime conversation rotates per round so a worker round never re-reads its own accumulated history. The worker's collector, abort registry and slot watchdog SHALL all key on that child id.

#### Scenario: Spawn on demand
- **WHEN** a task targeting persona P is due, no worker bound to P exists, and the pool is under cap
- **THEN** a worker is spawned bound to P and the task executes on it

#### Scenario: Reuse an idle same-persona worker
- **WHEN** a task targeting persona P is due and an idle worker bound to P exists
- **THEN** the task executes on that worker without spawning another

#### Scenario: Queue at cap
- **WHEN** a task is due, no matching idle worker exists, and the pool is at its cap
- **THEN** the task remains queued until a worker slot frees, and no worker is spawned

#### Scenario: Worker round rotates its runtime conversation

- **WHEN** a fleet task executes on a worker slot
- **THEN** the runtime is prompted under `<mirror>#r<startedAt>` (not the mirror id), the transcript still lands on the mirror id, and the collector/abort/watchdog keys are the child id

#### Scenario: No cross-claim of one conversation

- **WHEN** the pool holds more than one slot
- **THEN** two workers SHALL NOT be prompted under the same child conversation id (the observed failure was `session "…" is already owned by …`, first seen the hour the cap went from 1 to 3)

### Requirement: The pool is bounded and degrades gracefully
The pool size SHALL NOT exceed `TASK_WORKER_MAX`. At 0 the pool is inert — every execution runs on the primary slot with today's serial semantics (queue behind the active turn, persona switch before prompting). The value MAY be set per deployment; unset defaults to 0. A non-zero cap SHALL only be set where the cell's memory limit clears the wake-admission gate (`used + cell footprint` ≤ `limit × (1 − CELL_MEMORY_ADMISSION_FLOOR)`), because each worker is a second dsh bridge inside the same cell and a refused wake is a silent stall.

#### Scenario: Cap zero is today's serial behavior
- **WHEN** the cell runs with `TASK_WORKER_MAX=0`
- **THEN** task executions run on the primary slot exactly as before this capability, one at a time, queueing behind the live turn

#### Scenario: Cap is never exceeded
- **WHEN** many tasks for distinct personas are due simultaneously and the cap is N
- **THEN** at most N workers exist, and remaining tasks queue

#### Scenario: 开池前先过内存准入

- **WHEN** 部署把 `TASK_WORKER_MAX` 从 0 提到非零
- **THEN** 该 cell 的 `used + 足迹` 必须先小于 `limit × (1 − 0.15)`，否则唤醒被拒、池空转（2026-11-08 在 4Gi 上限下的实测形态），不得开池

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

Worker runtimes SHALL share the cell's composed profile (home, patches, credentials) and execute
with session ids scoped to their tasks; all worker state stays inside the cell's data directory and
is never observable from another cell. A worker crash restarts with backoff (the bridge's own
lifecycle) without affecting the primary runtime or other workers. A worker SHALL NOT bring its own
copy of the cell's MCP satellite processes: it SHALL attach to the cell's shared MCP host, so adding
a slot adds one dsh runtime and no satellites. With `TASK_WORKER_MAX=0` the composed shape SHALL stay
byte-for-byte unchanged.

#### Scenario: Worker crash is contained
- **WHEN** a worker's runtime exits unexpectedly mid-task
- **THEN** its task records a failed or interrupted execution and the primary runtime and other workers are unaffected

#### Scenario: 加一个槽不再加一套卫星

- **WHEN** 部署把 `TASK_WORKER_MAX` 从 0 调到 1 并触发一个 persona 任务
- **THEN** 该 cell 只新增一个 dsh runtime，卫星进程数保持不变
- **AND** 该槽的工具面与主 bridge 一致

#### Scenario: 槽内回合隔离不受影响

- **WHEN** 主 bridge 与 worker 槽同时有回合在跑
- **THEN** 两个回合各自的上下文仍互不可见（进程级隔离未变）

#### Scenario: 单 dsh 部署不受影响

- **WHEN** 部署为 `TASK_WORKER_MAX=0`
- **THEN** 组合出的 MCP 条目与运行时形态与变更前逐字节相同

### Requirement: 人的唤醒在人满时仍有通道
池激活（上限 > 0）且全部槽位被占时，人的消息/状态查询触发的唤醒 SHALL 可使用并发上限之外的一个额外槽；槽位分配 SHALL 唤醒优先于新启动——新启动 SHALL NOT 占用人优先槽。上限为 0 时本规则 SHALL 休眠：池不注册、不提供额外槽。人的唤醒的**排队优先级**不属于本规则——它由主槽串行链按 `task-engine` 的执行槽排序自行保证（越过未开始的排队执行），与池是否启用无关。

#### Scenario: 满载时人唤醒用额外槽
- **WHEN** 池上限为 2 且 2 个槽位均在执行中，此时一条人的消息唤醒某 persona
- **THEN** 该唤醒使用额外槽立即执行，无需等待在办任务结束

#### Scenario: 新启动不占人优先槽
- **WHEN** 全部常规槽位与额外槽均被占用（含一条在办的人唤醒），又一条新任务到达
- **THEN** 新任务按既有规则排队，SHALL NOT 抢占人优先槽

#### Scenario: cap 0 休眠逐字节一致
- **WHEN** 上限为 0（生产现状）
- **THEN** 池 SHALL NOT 注册，额外槽规则 SHALL NOT 生效
- **AND** 池侧的执行路径 SHALL 与未引入池时一致——本规则在 cap 0 下不改变任何一条执行的运行方式；
      人的唤醒的排队次序由 `task-engine` 的串行链负责，不属于池的这条规则
