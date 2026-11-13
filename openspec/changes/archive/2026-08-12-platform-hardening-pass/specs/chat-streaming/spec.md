## ADDED Requirements

### Requirement: The streaming guard is set synchronously at prompt dispatch
The server SHALL set the in-flight streaming guard (`isStreaming`) to `true` synchronously at prompt dispatch on the non-`steer` path — by a statement immediately preceding the first `await session.prompt()` — so that the check-and-set is atomic with respect to the event loop. A second prompt that interleaves at the dispatching prompt's first `await` SHALL observe the guard as `true` and take the `steer` branch instead of starting a second concurrent turn on the shared session. The `isStreaming = true` assignment in the `agent_start` event handler SHALL be treated as idempotent. This applies to both the normal prompt branch and the skill-invocation branch.

#### Scenario: a concurrent second prompt steers
- **WHEN** prompt A is dispatched on the non-steer path and has yielded at its first `await session.prompt()`, and prompt B arrives before the SDK emits `agent_start` for A
- **THEN** prompt B SHALL observe the in-flight guard as `true`
- **AND** SHALL be forwarded to the SDK with `steer` behavior instead of starting a second turn

#### Scenario: the guard is set before the first await
- **WHEN** a prompt is dispatched on the non-steer path (normal or skill branch)
- **THEN** the in-flight guard SHALL be set to `true` by a synchronous statement immediately preceding the first `await session.prompt()`
- **AND** no `await` SHALL occur between the in-flight check and the in-flight set

## MODIFIED Requirements

### Requirement: A failed or aborted turn resets streaming state and emits done
The server SHALL ensure that every agent turn ends with the streaming state reset and a `done` event broadcast to clients, regardless of whether the turn succeeded or failed. Because the in-flight streaming guard is set synchronously at prompt dispatch (before the first `await session.prompt()`), a turn whose `session.prompt()` rejects before the SDK emits `agent_start` SHALL still have the guard set, so the catch path's `finishTurn()` reliably resets state and broadcasts `done`. The server SHALL broadcast any `error` before `done`, SHALL NOT broadcast `done` more than once per turn, and the `agent_start` handler's guard assignment and `streamedTextThisTurn = false` reset SHALL remain in place as idempotent operations.

#### Scenario: failed turn re-enables the UI
- **WHEN** an agent turn fails with an error before completion (including before `agent_start` fires)
- **THEN** the server SHALL broadcast an `error` followed by `done`
- **AND** the streaming flag SHALL be reset to false
- **AND** the model selector and input SHALL be re-enabled

#### Scenario: done is not duplicated
- **WHEN** the SDK emits `agent_end` after the server already broadcast `done` for a failed turn
- **THEN** the server SHALL NOT broadcast `done` a second time
