# chat-streaming Specification

## Purpose
TBD - created by archiving change e2e-tests-and-bugfixes. Update Purpose after archive.
## Requirements
### Requirement: Keyboard shortcut toggles all thinking blocks
The chat UI SHALL support a keyboard shortcut (`Ctrl+O` or `Cmd+O` on macOS) to toggle the expansion state of all activity groups simultaneously.

#### Scenario: Ctrl+O toggles thinking block visibility
- **WHEN** the user presses `Ctrl+O` (Windows/Linux) or `Cmd+O` (macOS)
- **THEN** all activity groups in the chat SHALL toggle between collapsed/expanded state
- **AND** the inner per-block collapse states SHALL NOT be affected

### Requirement: Assistant text is streamed to clients as deltas
The server SHALL stream assistant text to connected WebSocket clients as incremental `text` events (`{ type: "text", delta }`) as the model produces output, so the UI updates live during a turn.

#### Scenario: streamed text appears live
- **WHEN** the model emits a text delta during a turn
- **THEN** the server SHALL broadcast a `text` event carrying that delta
- **AND** the UI SHALL append the delta to the current assistant bubble

### Requirement: Each assistant text segment is emitted exactly once per turn
The server SHALL deliver each assistant text segment to clients exactly once per turn. The server SHALL NOT re-broadcast the full assistant text on both `message_end` and `agent_end`; the final text SHALL be emitted at most once, and only as a fallback when no text was streamed during the turn (e.g. a non-streaming model response).

#### Scenario: streaming model response is not duplicated
- **WHEN** the model streams its response via text deltas during the turn
- **THEN** the server SHALL NOT emit the full text again on `message_end` or `agent_end`
- **AND** the rendered assistant text SHALL equal the model's response exactly once

#### Scenario: non-streaming response is emitted once via fallback
- **WHEN** the model produces a response with no streamed text deltas
- **THEN** the server SHALL emit the final assistant text exactly once on turn completion
- **AND** the rendered assistant text SHALL equal the model's response exactly once

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

### Requirement: Chat prompt submission does not throw errors
Submitting a chat prompt SHALL send the message over WebSocket and SHALL NOT throw JavaScript errors. The submit handler SHALL properly handle null or undefined references, check WebSocket connection state, and validate input before submission.

#### Scenario: submitting a valid prompt
- **WHEN** user types a valid message and clicks Send
- **THEN** the message SHALL be sent over the WebSocket
- **AND** no JavaScript error SHALL be thrown
- **AND** the input SHALL be disabled during streaming

#### Scenario: submitting with no WebSocket connection
- **WHEN** user submits a prompt when WebSocket is not connected
- **THEN** the UI SHALL show an error message
- **AND** SHALL NOT throw a JavaScript error
- **AND** the input SHALL remain enabled

### Requirement: Empty prompt submission is prevented
The UI SHALL prevent submission of empty or whitespace-only prompts. The send button SHALL be disabled when the input is empty.

#### Scenario: send button disabled for empty input
- **WHEN** the input is empty or contains only whitespace
- **THEN** the send button SHALL be disabled

#### Scenario: whitespace-only input not submitted
- **WHEN** user types only whitespace and tries to submit
- **THEN** no message SHALL be sent
- **AND** no error SHALL be thrown

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


### Requirement: Retry progress is visible in the session stream

Durable retry events emitted by the runtime's request-retry machinery (a scheduled retry with its delay and attempt budget, and a started retry) SHALL be forwarded to connected clients as session-stream events and rendered as visible progress on the affected turn (e.g. "网关限流，重试中 (2/5)"), not silently swallowed. Retry events SHALL NOT appear as assistant text and SHALL NOT alter the turn's durable message history.

#### Scenario: rate-limited request shows retry progress
- **WHEN** a model request fails with a transient rejection and the runtime schedules a retry
- **THEN** clients SHALL see a retry-scheduled indication for that turn including attempt number and budget
- **AND** when the retry starts, the indication SHALL update

#### Scenario: retry succeeds
- **WHEN** a scheduled retry completes the request successfully
- **THEN** the turn SHALL proceed normally and the retry indication SHALL resolve without a fatal turn error

#### Scenario: retry budget exhausted
- **WHEN** all retry attempts for a request are exhausted
- **THEN** the turn SHALL end with the real error surfaced per the failure-rendering behavior

### Requirement: Socket loss leaves the in-flight turn in a transient reconnect state, not a local finalize

When the client socket drops while a turn is streaming, the client SHALL NOT mark the turn as interrupted, SHALL NOT flip `isStreaming` to false, and SHALL NOT arm event suppression for the orphaned run. The open turn SHALL instead carry a transient "connection lost, resuming…" state (page-level banner semantics unchanged), tool blocks SHALL keep their running/last-known states, and the composer SHALL keep its streaming affordance (stop control). The interrupted marker's regular source SHALL be the user's explicit stop action; a disconnect alone SHALL never finalize a turn locally.

#### Scenario: disconnect mid-turn shows a transient state

- **WHEN** the socket drops while an assistant turn is streaming
- **THEN** the turn SHALL display a transient connection-lost/resuming indicator
- **AND** SHALL NOT display the interrupted marker
- **AND** `isStreaming` SHALL remain true and the stop control SHALL remain available

#### Scenario: tool blocks keep their states through a drop

- **WHEN** the socket drops while a tool block is in the running state
- **THEN** the tool block SHALL keep rendering its running/last-known state
- **AND** the view SHALL NOT simultaneously show a tool block as running and the turn as interrupted

#### Scenario: user stop remains an interruption source

- **WHEN** the user activates the stop control while a turn is streaming
- **THEN** the turn SHALL be marked interrupted as today

### Requirement: Reconnect sync restores the in-flight turn from the server's answer

After a socket reconnect, the client SHALL re-sync the active session (send `switch_session` for the current session when one is active). On the sync response the client SHALL branch on `running`:

- `running: true` with a turn event log — the client SHALL discard its local open turn and reconstruct it by folding the replayed events in order, then continue live streaming (the replay's content SHALL supersede the local partial; no visible text shrink may occur since the replay starts from turn start).
- `running: true` without a log (buffer miss) — the client SHALL keep its local open turn, mark it "resumed, content may lag", and continue appending live events; the transcript converges when the run's `done` persists the full text.
- `running: false` — the client SHALL apply today's full transcript replace, which truthfully finalizes a turn that ended during the blackout.

#### Scenario: replay reconstructs the turn seamlessly

- **WHEN** the sync response arrives with `running: true` and an event log after a mid-run drop
- **THEN** the client SHALL rebuild the open turn from the replayed events and resume live streaming
- **AND** text already visible before the drop SHALL NOT disappear in the process

#### Scenario: buffer miss keeps the local partial and converges at done

- **WHEN** the sync response arrives with `running: true` and no event log
- **THEN** the client SHALL keep its local open turn with a resumed/lagging indicator
- **AND** live events SHALL continue appending
- **AND** when the run completes, the persisted full text SHALL be what later loads show

#### Scenario: turn ended during the blackout finalizes truthfully

- **WHEN** the sync response arrives with `running: false` after a drop
- **THEN** the client SHALL replace the transcript with the server's persisted one, showing the turn's true final state

#### Scenario: total disconnect never fakes a terminal state

- **WHEN** the socket never reconnects after a drop
- **THEN** the client SHALL keep the transient connection-lost state without finalizing the turn
- **AND** a later page load SHALL show the server's authoritative transcript
