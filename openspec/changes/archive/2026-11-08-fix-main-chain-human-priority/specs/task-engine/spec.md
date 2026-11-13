## MODIFIED Requirements

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
