# chat-streaming — Delta

## MODIFIED Requirements

### Requirement: The streaming guard is set synchronously at prompt dispatch

The server SHALL set the in-flight streaming guard for the TARGET SESSION synchronously at prompt dispatch on the non-`steer` path — by a statement immediately preceding the first `await session.prompt()` — so that the check-and-set is atomic with respect to the event loop. 守卫 SHALL 按会话记录（每会话独立流状态）；会话 B 的 prompt SHALL NOT 因会话 A 正在流中被拒绝或阻塞。A second prompt interleaving at the dispatching prompt's first `await` ON THE SAME SESSION SHALL observe that session's guard as `true` and take the `steer`/reject branch instead of starting a second concurrent turn on the shared session. The `isStreaming` assignment in the `agent_start` event handler SHALL be treated as idempotent. This applies to both the normal prompt branch and the skill-invocation branch.

#### Scenario: a concurrent second prompt steers
- **WHEN** prompt A is dispatched on the non-steer path and has yielded at its first `await session.prompt()`, and prompt B arrives on the SAME session before the SDK emits `agent_start` for A
- **THEN** prompt B SHALL observe that session's in-flight guard as `true`
- **AND** SHALL be forwarded with `steer` behavior instead of starting a second turn on that session

#### Scenario: the guard is set before the first await
- **WHEN** a prompt is dispatched on the non-steer path (normal or skill branch)
- **THEN** the target session's in-flight guard SHALL be set to `true` by a synchronous statement immediately preceding the first `await session.prompt()`
- **AND** no `await` SHALL occur between the in-flight check and the in-flight set

#### Scenario: a different session's prompt is not blocked
- **WHEN** session A is streaming and a prompt arrives for session B
- **THEN** the server SHALL dispatch B's prompt normally
- **AND** SHALL NOT reject it with an agent-busy error nor restart the runtime

## ADDED Requirements

### Requirement: Stop and session-switch cancel the turn via the bridge

用户停止与切会话停流 SHALL 经 `session/cancel` RPC 真中断目标会话的活跃回合（见 live-runtime-control），SHALL NOT 以重启子进程方式停流。取消后的回合 SHALL 以中止态收尾：`error`（如适用）→ `done` 播报照常，目标会话的流状态复位。客户端的视图级停止（`stopStreaming`）保留为降级路径（桥未声明能力时）。

#### Scenario: stop cancels server-side

- **WHEN** 用户在流中点击停止且桥声明 `session/cancel`
- **THEN** 服务端 SHALL 中断该会话回合并广播 `done`
- **AND** 该回合 SHALL 标记为中断（非静默吞事件）

#### Scenario: switching sessions no longer restarts the runtime

- **WHEN** 会话 A 流中用户切到会话 B
- **THEN** 服务端 SHALL cancel A 的回合而 SHALL NOT 重启子进程
- **AND** B 的首个 prompt SHALL 即时可发（不再撞重启窗口报错）

### Requirement: Prompt submission is latched against duplicates

客户端 SHALL 对 prompt 提交加闭锁：自 `prompt` 消息发出至该回合的 `user` 回显（或超时）期间，同一输入源的重复提交（Enter 键重复、双击）SHALL 被吞并。发出后到 `agent_start` 前，界面 SHALL 呈现进行中反馈（用户气泡挂 pending 指示），且 `canSend` SHALL 在当前会话流中为 false。

#### Scenario: Enter 键重复不产生第二条消息

- **WHEN** 用户按住 Enter 触发键重复，首击已发出 prompt
- **THEN** 后续重复击键 SHALL 不再发出 `prompt` 消息
- **AND** 界面 SHALL 只出现一条该文本的用户气泡

#### Scenario: 发出即有进行中反馈

- **WHEN** prompt 已发出而 `agent_start` 尚未到达
- **THEN** 界面 SHALL 显示该回合的 pending 指示（发送控件呈进行中态）
- **AND** 当前会话的发送 SHALL 被阻止直到回合结束
