# turn-dispatch Specification

## Purpose
宿主侧回合派发器：web 车道的每条 prompt 经它派发。它是「共享 dsh 子进程同一时刻最多一个开着的回合」这一正确性不变量的唯一强制点；运行时忙时把 prompt 排队而非拒绝或并发派发，并把排队态播给会话的观看者。

## Requirements

### Requirement: Web prompts dispatch through a single arbiter enforcing one open turn

The server SHALL route every web-lane prompt (normal prompt and skill invocation alike, including remote-agent forks) through one dispatcher. The dispatcher SHALL dispatch a prompt immediately only when the shared runtime has no open turn; otherwise it SHALL enqueue it. Dispatch SHALL set the target session's in-flight guard synchronously before the first `await` (the guard contract in `chat-streaming`). No other web path SHALL hand a prompt to the runtime directly.

#### Scenario: idle runtime dispatches immediately
- **WHEN** a client sends `prompt` for session B and no session has an open turn
- **THEN** the server SHALL dispatch it at once (user echo → `agent_start` follow as today)

#### Scenario: concurrent prompts from two connections never both enter the runtime
- **WHEN** two connections send prompts for sessions A and B in the same tick while the runtime is idle
- **THEN** exactly one SHALL be dispatched and the other SHALL be queued
- **AND** at no time SHALL two web turns be open in the shared runtime

### Requirement: Busy means any open turn in the shared runtime, not only web turns

The dispatcher SHALL treat the runtime as busy when any web session has an in-flight turn, OR when any non-web lane (scheduled task, bot, delegation summary) has an open turn in the shared runtime, OR when a lane holds a pending reservation (it has committed to prompt but its turn is not yet observable). Turns executed by worker-pool children SHALL NOT count — they run in separate processes.

#### Scenario: prompt during a scheduled-task turn is queued
- **WHEN** a scheduled task's turn is open in the shared runtime and a client sends a prompt for session B
- **THEN** the server SHALL queue B's prompt
- **AND** SHALL dispatch it after the task's turn closes

#### Scenario: a scheduled task's reservation holds across the runtime restart it causes
- **WHEN** a scheduled task has passed its idle wait and is switching the runtime preset (a restart) while session B's prompt is queued
- **THEN** the dispatcher SHALL NOT dispatch B when the runtime reports ready
- **AND** SHALL dispatch B only after the task's turn has closed

### Requirement: A prompt into a busy runtime is queued, never rejected for busyness and never dispatched concurrently

Under the default policy, a prompt for a session with no in-flight or queued turn SHALL be accepted and queued when the runtime is busy. The server SHALL NOT reject it as "agent is still responding", and SHALL NOT dispatch it into the runtime alongside the open turn. Queued prompts SHALL dispatch FIFO as the runtime becomes idle. Dispatch SHALL be triggered on every idle transition (a web turn closes, a non-web lane's turn closes, the runtime becomes ready after a restart), and a bounded periodic check SHALL run while the queue is non-empty so a missed trigger can never strand a queued prompt.

#### Scenario: second session queues behind the first
- **WHEN** session A's turn is in flight and a client sends a prompt for session B
- **THEN** the server SHALL queue B's prompt and report it as queued to B's viewers
- **AND** A's turn SHALL continue unaffected
- **AND** when A's turn closes, B's prompt SHALL dispatch without further client action

#### Scenario: FIFO across sessions
- **WHEN** prompts for sessions B then C are queued while A runs
- **THEN** B SHALL dispatch before C

### Requirement: Queue is bounded and holds at most one entry per session

The queue SHALL hold at most one pending prompt per session and at most `TURN_QUEUE_MAX` (default 8) entries in total. A prompt for a session that already has a queued entry SHALL be rejected with the existing in-flight error shape and a message distinguishing "already queued". A prompt arriving when the queue is full SHALL be rejected with `error{ code: "queue_full" }`. Both checks SHALL complete synchronously before the first `await` so two prompts in the same tick cannot both pass.

#### Scenario: same session cannot queue twice
- **WHEN** session B already has a queued prompt and a viewer sends another prompt for B
- **THEN** the server SHALL reject the second with an error and leave the queue unchanged

#### Scenario: queue full
- **WHEN** the queue already holds `TURN_QUEUE_MAX` entries and a prompt arrives for a session without an entry
- **THEN** the server SHALL reject it with `error{ code: "queue_full" }`

### Requirement: Queued state is visible to the session's viewers

On enqueue the server SHALL send `queued { sessionId, text, position, waitingOn }` to the connections viewing that session, where `waitingOn` is `{ id, title }` of the web session whose turn is open, or `null` when the open turn belongs to a non-web lane. On dispatch the server SHALL send `dequeued { sessionId, reason: "dispatched" }` to those viewers before the normal user echo and `agent_start`. The `sessions` list payload SHALL carry `turnStatus: "running" | "queued" | null` per entry and SHALL be re-broadcast on enqueue, dequeue and dispatch in addition to turn end. The `session_loaded` response for a session with a queued prompt SHALL carry `queued: { text, position, waitingOn }`; otherwise `queued` SHALL be absent or null. All fields are additive — older clients ignore them.

#### Scenario: viewers learn about the queue
- **WHEN** B's prompt is queued while A runs
- **THEN** every connection viewing B SHALL receive `queued` with B's text, position 1 and `waitingOn` naming A
- **AND** the next `sessions` broadcast SHALL mark A `running` and B `queued`

#### Scenario: reload restores the queued state
- **WHEN** a client switches to (or re-syncs) session B while B's prompt is queued
- **THEN** `session_loaded` SHALL carry `queued` with the text, position and `waitingOn`

#### Scenario: dispatch clears the queued state deterministically
- **WHEN** B's queued prompt dispatches
- **THEN** B's viewers SHALL receive `dequeued{ reason: "dispatched" }` followed by the user echo and `agent_start`

### Requirement: A queued prompt can be cancelled before dispatch

A `stop_turn` for a session whose prompt is queued (not in flight) SHALL remove it from the queue without touching the runtime and SHALL send `dequeued { sessionId, reason: "cancelled" }` to that session's viewers. Cancelling a queued prompt SHALL NOT emit `done` and SHALL NOT create a history row. A `stop_turn` naming the session whose turn is open (the `waitingOn` target) SHALL behave exactly as an explicit stop on that session; its close SHALL let the queue advance.

#### Scenario: cancel while queued
- **WHEN** B's prompt is queued and a viewer of B sends `stop_turn{ id: B }`
- **THEN** the server SHALL dequeue it and send `dequeued{ reason: "cancelled" }` to B's viewers
- **AND** the runtime SHALL receive no request for B

#### Scenario: preempt the running session from the queued one
- **WHEN** B is queued behind A and a client sends `stop_turn{ id: A }`
- **THEN** A's turn SHALL be cancelled and closed as aborted
- **AND** B's prompt SHALL dispatch as a consequence of A closing

### Requirement: History mirror happens at dispatch; demo budget is consumed at acceptance

The user message of a queued prompt SHALL be mirrored into chat history only when it dispatches, so a cancelled queued prompt leaves no history row. The demo/sandbox prompt budget, where one applies to the connection, SHALL be consumed when the prompt is accepted (enqueued or dispatched) and SHALL NOT be refunded on cancel.

#### Scenario: cancelled queued prompt leaves no trace in history
- **WHEN** a queued prompt is cancelled
- **THEN** the session's message list SHALL NOT contain that text

#### Scenario: budget counts on acceptance
- **WHEN** a demo-capped connection's prompt is queued
- **THEN** its remaining budget SHALL decrease by one at that moment

### Requirement: Queue survives runtime restarts but not process exit

Queued prompts SHALL be held in process memory only. A runtime child restart (MCP update, preset switch, crash respawn) SHALL NOT discard queued prompts; the dispatcher SHALL resume dispatching once the runtime reports ready and no lane holds it. A server process exit SHALL drop the queue (same durability class as the in-flight replay log).

#### Scenario: planned restart keeps the queue
- **WHEN** B's prompt is queued and the runtime child restarts for an MCP change
- **THEN** B's prompt SHALL still be queued after the restart
- **AND** SHALL dispatch once the runtime is ready and idle

### Requirement: Dispatch policy is a deployment capability statement

The policy SHALL be selected by `TURN_DISPATCH` with values `legacy`, `queue` (default) and `concurrent`. `legacy` SHALL reproduce the pre-change behavior (session switch cancels the outgoing turn; cross-session prompts dispatch without queueing) and exists solely for rollback. `concurrent` SHALL dispatch web prompts immediately regardless of busyness; per-session event routing, history mirroring and turn close SHALL stay isolated per session. The policy SHALL NOT be user-selectable at runtime.

`concurrent` SHALL be honored only when the deployment sets `DSH_MATRIX_CLOSE_INTERLEAVE=1`. That latch SHALL be set only on a deployment whose runtime has a RECORDED close-under-concurrency verification — either the `dsh-contracts` ⑨b row once it is rebuilt to park the conversation request itself (the 2026-10-19 row parked the session-title side call and carries no evidence; see dsh-matrix/README.md 勘误), or a real-cell experiment protocol (temporary cell on the production engine and real provider; symmetric concurrent rounds asserting overlapping turn lifetimes, and asymmetric rounds asserting one turn closes entirely inside another's in-flight request; no `queued`, no `error`, no wedge, bounded rounds). When the latch is absent the server SHALL fall back to `queue` and log a warning at boot.

The code default SHALL remain `queue` until ⑨b is an honest, green gate; production deployments may enable `concurrent` per this requirement (production did on 2026-10-20: 8 symmetric + 6 asymmetric real-cell rounds, `openspec/changes/flip-turn-dispatch-concurrent/notes/evidence.md`).

#### Scenario: concurrent dispatches both prompts at once
- **WHEN** the policy is `concurrent`, session A's turn is open, and a client sends a prompt for session B
- **THEN** B's prompt SHALL dispatch immediately (user echo → `agent_start`), with no `queued` event
- **AND** each session's viewers SHALL receive only their own session's events through both turns' closes

#### Scenario: one turn closes inside another's open request
- **WHEN** the policy is `concurrent` and B's short turn completes while A's longer turn is still generating
- **THEN** B's viewers SHALL receive `done` for B
- **AND** A's turn SHALL continue unaffected and close with its own `done`

#### Scenario: concurrent refused on an unverified matrix
- **WHEN** the server boots with `TURN_DISPATCH=concurrent` and `DSH_MATRIX_CLOSE_INTERLEAVE` is not `1`
- **THEN** the server SHALL run the `queue` policy and log a warning naming the reason

#### Scenario: legacy restores the old switch behavior
- **WHEN** the server runs with `TURN_DISPATCH=legacy` and a user switches away from a streaming session
- **THEN** the outgoing session's turn SHALL be cancelled as before the change
