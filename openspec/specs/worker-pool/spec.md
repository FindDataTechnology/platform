## Purpose

The cell's task-worker slots: on-demand dsh runtime instances, each pinned to one persona, that execute task-engine dispatches in parallel while the interactive primary runtime serves the conversation. Serial mode (cap 0) is exactly today's behavior — the pool is a pure widening of where executions run.

## Requirements

### Requirement: Workers spawn on demand with persona affinity

The pool SHALL execute a due task targeting persona P on an idle worker bound to P. When no such worker exists and the pool is under its cap, one SHALL be spawned for P. When the pool is at its cap, the task SHALL queue — but "at cap" SHALL mean **cap workers that are either busy or bound to a persona some queued task still targets**: an idle worker whose persona no queued task targets SHALL NOT lock the slot. The pool SHALL retire such a worker (graceful shutdown, same path as the idle reap) and start the due task's worker within that same slot, so the total worker count never exceeds the cap. Retirement SHALL prefer the longest-unused idle worker and MUST NOT take an idle worker whose persona still has a queued task. With no retirable idle worker the task SHALL queue exactly as before. A worker SHALL keep its persona for its entire lifetime. A worker's turn SHALL be prompted under the SAME per-round child conversation id the primary chain derives (`roundChildSessionId`), never the stable mirror session id: the mirror id stays the transcript/sidebar id, while the runtime conversation rotates per round so a worker round never re-reads its own accumulated history. The worker's collector, abort registry and slot watchdog SHALL all key on that child id.

#### Scenario: Spawn on demand

- **WHEN** a task targeting persona P is due, no worker bound to P exists, and the pool is under cap
- **THEN** a worker is spawned bound to P and the task executes on it

#### Scenario: Reuse an idle same-persona worker

- **WHEN** a task targeting persona P is due and an idle worker bound to P exists
- **THEN** the task executes on that worker without spawning another

#### Scenario: Queue at cap

- **WHEN** a task is due, no matching idle worker exists, the pool holds cap workers, and no idle worker may be retired (none is idle, or every idle worker's persona still has a queued task)
- **THEN** the task remains queued until a worker slot frees, and the total worker count does not exceed the cap

#### Scenario: 空闲 worker 不占名额

- **WHEN** 池已满（4 个 worker），其中 2 个空闲且其岗位没有任何排队任务，此时一条岗位不匹配的排期轮到期
- **THEN** 池回收一个最久未用的空闲 worker 并在同一名额内为新岗位启动 worker，该排期轮立即开跑
- **AND** 整个过程 worker 总数不超过 `TASK_WORKER_MAX`，且回收留一行日志说明被回收的岗位

#### Scenario: 岗位仍有人等的空闲 worker 不被回收

- **WHEN** 池已满，唯一的空闲 worker 绑定的岗位仍有若干排队任务，此时另一岗位的轮次到期
- **THEN** 该空闲 worker SHALL NOT 被回收，新岗位的轮次留在队列里等槽释放（与变更前一致）

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

A worker's child `cwd` SHALL be the working directory of the run it executes. When the deployment
declares no run workbench (`workbench = off`, the default), the child's `cwd` SHALL be the
deployment's single workspace exactly as before, and the composed shape SHALL stay byte-for-byte
unchanged.

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

#### Scenario: 每个槽跑在自己的工作台上

- **WHEN** 某部署声明了运行工作台，两个 worker 槽同时执行两个运行
- **THEN** 两个 child 的工作目录是两个不同的工作台
- **AND** 各自的运行台账指向自己的工作台地址

#### Scenario: 未声明工作台时逐字节不变

- **WHEN** 部署未声明运行工作台（默认 `off`）
- **THEN** 每个 worker child 的 `cwd` 与变更前相同，均为部署的单一工作区

### Requirement: 人的唤醒在人满时仍有通道

池激活（上限 > 0）且全部槽位被占时，人的消息/状态查询触发的唤醒 SHALL 可使用并发上限之外的一个额外槽；槽位分配 SHALL 唤醒优先于新启动——新启动 SHALL NOT 占用人优先槽。上限为 0 时本规则 SHALL 休眠：池不注册、不提供额外槽。

人的点火的**排队次序** SHALL 由当前生效的执行路径保证，且两条路径的责任划分如下：池激活时，由池的派发器在认领排队任务时保证；上限为 0（串行模式）时，由 `task-engine` 的执行槽排序保证（越过未开始的排队执行）。任一路径 SHALL NOT 假定另一条路径会代为保证——池激活后派发器直接认领排队任务，不经过串行链。

排序 SHALL NOT 扩大容量：越过排队只改变**次序**，不产生新的并发槽位。额外槽的归属 SHALL 仅由「人的唤醒」这一事实决定，SHALL NOT 因任务获得更高排队次序而扩大。

两个标记 SHALL NOT 互相替代，且各自语义固定：
- 点火来源标记（`queuedBy`）表示「这一轮由人按下」，决定排队次序与老化豁免，SHALL NOT 授予额外槽；
- 唤醒标记（`humanPriority`）表示「这是一次人的唤醒」，决定额外槽的占用，SHALL NOT 被点火来源标记替代。

老化豁免 SHALL 以「该轮仍有机会执行」为前提，MUST NOT 无限期保持「不丢也不跑」：

- 一条点火轮的队列等待达到老化上限的 **3 倍**（下限为该轮的回合预算或 60 分钟中较大者）仍未被派发时，系统 SHALL 如实处置，不得继续静默占用队列位置。
- 该轮**有**下一次排期（`nextRun` 非空）时，SHALL 允许其按普通轮被 `skipped`，error 写明"点火轮等待超限且未获槽位，由下一次排期接替"。
- 该轮**无**下一次排期（manual 轮，`nextRun` 为空）时，SHALL NOT 丢弃（丢弃即永久丢失），但 SHALL 在就绪面被标为 `stalledIgnition`（或等价的可辨识状态），使运维可见。

#### Scenario: 点火轮等待超限且无槽时如实降级（有排期）

- **WHEN** 一条 `queuedBy=human` 的排期轮等待超过老化上限的 3 倍，期间没有任何匹配 persona 的槽位释放
- **THEN** 该轮 SHALL 被标 `skipped`，error 说明等待超限与由下一次排期接替
- **AND** 系统 MUST NOT 让它继续静默排队

#### Scenario: 无排期的点火轮不被丢弃但必须可见

- **WHEN** 一条 `queuedBy=human` 的 manual 轮（`nextRun` 为空）等待超过同一上限且未获槽位
- **THEN** 该轮 SHALL NOT 被丢弃
- **AND** 就绪面 SHALL 将其暴露为可辨识的停滞状态，使运维能判定「这是等人处理，不是系统故障」

#### Scenario: 未超限的点火轮仍按既有豁免排队

- **WHEN** 一条点火轮等待未达上述上限
- **THEN** 既有豁免 SHALL 继续生效：它不因老化被丢弃，继续等待槽位

#### Scenario: 满载时人唤醒用额外槽
- **WHEN** 池上限为 2 且 2 个槽位均在执行中，此时一条人的消息唤醒某 persona
- **THEN** 该唤醒使用额外槽立即执行，无需等待在办任务结束

#### Scenario: 新启动不占人优先槽
- **WHEN** 全部常规槽位与额外槽均被占用（含一条在办的人唤醒），又一条新任务到达
- **THEN** 新任务按既有规则排队，SHALL NOT 抢占人优先槽

#### Scenario: cap 0 休眠逐字节一致
- **WHEN** 上限为 0（生产现状）
- **THEN** 池 SHALL NOT 注册，额外槽规则 SHALL NOT 生效
- **AND** 池侧的执行路径 SHALL 与未引入池时一致——本规则在 cap 0 下不改变任何一条执行的运行方式；人的点火的排队次序由 `task-engine` 的串行链负责，不属于池的这条规则

#### Scenario: 池激活时点火越过排队
- **WHEN** 池上限为 1 且槽位在执行中，队列里已有先入队的定时触发，随后操作者对一条既有定时任务按下 `run now`（点火来源标记生效）
- **THEN** 槽位释放后 SHALL 先执行被点火的这一轮，再执行先入队的定时触发
- **AND** 该次序 SHALL 在排序策略开关关闭时退回先入先出，与变更前逐字节一致

#### Scenario: 排序不扩大容量
- **WHEN** 池上限为 1 且槽位在执行中，操作者对一条既有定时任务按下 `run now`，此时不存在空闲槽
- **THEN** 该轮 SHALL 保持排队，SHALL NOT 促成上限之外的额外槽
- **AND** 同一时刻一条真正的人唤醒 SHALL 仍可使用额外槽——两者不互相替代

### Requirement: 池只认领有岗位的目标

池 SHALL 只认领能在其中钉住一个岗位的执行。非岗位目标 SHALL NOT 被池认领，每个 SHALL 按其自身语义回落主链的专属执行器：

| targetType | 主链执行器 | 理由 |
|---|---|---|
| `a2a` | 远端回合 | 目标在别的 agent 上，本地没有可钉的岗位 |
| `cluster` | 集群扇出 | `preset` 里是集群 id，钉成岗位会启动一个坏 child |
| `tool` | 工具执行器（一次确定性 MCP 调用） | 目标是一个 MCP 工具，不是 agent；没有回合、不换岗位、不烧 LLM |

该判定 SHALL 依据 `targetType` 本身，MUST NOT 依赖"是否带 `preset` 字段"间接得出——引擎对工具任务恒写 `preset=<工具名>`（`persona ?? agent ?? tool`），这条间接判据对它们永远为真，工具任务因此混进岗位车道并以 `Unknown agent preset: <工具名>` 失败。

未被认领的执行 SHALL 走与池未注册（cap 0）时完全相同的路径，本判定 MUST NOT 改变它们的执行方式。

#### Scenario: 工具岗的排期轮不被池抢走

- **WHEN** 一条 `targetType=tool` 的排期轮到期（其 `preset` 按既定形状就是工具名 `server::tool`），池有空闲槽
- **THEN** 池 SHALL NOT 认领它，MUST NOT 以该工具名作为岗位启动 worker
- **AND** 该轮 SHALL 在主链的工具执行器上完成一次工具调用

#### Scenario: 池的派发留痕能说清原因

- **WHEN** `WORKER_POOL_DEBUG=1` 打开，一条 `targetType=tool` 的执行经过派发判定
- **THEN** 日志 SHALL 打印 `-> fallback:targetType=tool`

#### Scenario: 岗位目标的行为逐字节不变

- **WHEN** 一条 `targetType=persona`（或缺省）的执行到期
- **THEN** 池的认领行为与本变更之前完全一致

### Requirement: 槽位归还时工作台一并交还

worker 槽位在运行结束时归还；该运行的工作台 SHALL 随槽位归还有序进入回收流程（保留期后删除），MUST NOT 随下一次运行被复用。

工作台回收失败 MUST NOT 阻塞或破坏槽位的归还：槽位可用性优先，残留工作台由 sweeper 收敛。

#### Scenario: 槽位可复用而残留不阻塞

- **WHEN** 一次 worker 运行结束，但其工作台删除失败
- **THEN** 槽位立即归还并可被下一次运行使用
- **AND** 残留工作台由 sweeper 在一个回收周期内收敛，不阻塞派生
