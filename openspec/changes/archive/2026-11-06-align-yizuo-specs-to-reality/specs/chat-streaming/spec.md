## MODIFIED Requirements

### Requirement: The streaming guard is set synchronously at prompt dispatch

The server SHALL set the in-flight streaming guard for the TARGET SESSION synchronously at prompt dispatch on the non-`steer` path — by a statement immediately preceding the first `await session.prompt()` — so that the check-and-set is atomic with respect to the event loop. 守卫 SHALL 按会话记录（每会话独立流状态）；会话 B 的 prompt SHALL NOT 因会话 A 正在流中被拒绝或阻塞。A second prompt interleaving at the dispatching prompt's first `await` ON THE SAME SESSION SHALL observe that session's guard as `true` and take the `steer`/reject branch instead of starting a second concurrent turn on the shared session. The `isStreaming` assignment in the `agent_start` event handler SHALL be treated as idempotent. This applies to both the normal prompt branch and the skill-invocation branch.

#### Scenario: a concurrent second prompt steers

- **WHEN** prompt A is dispatched on the non-steer path and has yielded at its first `await session.prompt()`, and prompt B arrives on the SAME session before the SDK emits `agent_start` for A
- **THEN** prompt B SHALL observe that session's in-flight guard as `true`
- **AND** SHALL be rejected with a structured error while a turn is streaming instead of starting a second turn on that session

#### Scenario: the guard is set before the first await
- **WHEN** a prompt is dispatched on the non-steer path (normal or skill branch)
- **THEN** the target session's in-flight guard SHALL be set to `true` by a synchronous statement immediately preceding the first `await session.prompt()`
- **AND** no `await` SHALL occur between the in-flight check and the in-flight set

#### Scenario: a different session's prompt is not blocked
- **WHEN** session A is streaming and a prompt arrives for session B
- **THEN** the server SHALL dispatch B's prompt normally
- **AND** SHALL NOT reject it with an agent-busy error nor restart the runtime
