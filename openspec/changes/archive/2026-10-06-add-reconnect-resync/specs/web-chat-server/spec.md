## ADDED Requirements

### Requirement: In-flight turn events are buffered server-side for replay

While a turn is in flight, the server SHALL maintain an in-memory replay log of that turn's run events (`agent_start`, `text`, `thinking`, `tool_start`, `tool_update`, `tool_end`, `skill_use`, and the terminal `done`/`error` ordering as delivered) scoped to the running session, derived from the same emit path that delivers events to viewers. The log SHALL be bounded (event count and serialized size caps); on overflow the log SHALL be dropped and treated as a miss. The log SHALL be cleared when the turn ends (`done` broadcast) and on turn-abort paths, and SHALL NOT survive process restart (no persistence).

#### Scenario: buffer accumulates a live turn

- **WHEN** a turn starts and run events are delivered to viewers
- **THEN** the same events SHALL also be appended to the in-flight turn's replay log in delivery order

#### Scenario: buffer is cleared at turn end

- **WHEN** a turn ends (`done` broadcast)
- **THEN** the replay log for that turn SHALL be cleared

#### Scenario: bounded buffer degrades to a miss

- **WHEN** the replay log exceeds its size or count cap
- **THEN** the log SHALL be dropped and subsequent sync responses for that turn SHALL behave as a buffer miss

#### Scenario: process restart leaves no buffer

- **WHEN** the server process restarts while a turn was in flight
- **THEN** no replay log SHALL exist for that turn (sync falls back to the miss path)

### Requirement: session_loaded carries turn-in-flight status and replay payload

The `session_loaded` response to `switch_session` SHALL include a `running` boolean derived from the server's turn-origin state (`running: true` only when a turn is in flight for the target session). When `running` is true and the replay log is present, the response SHALL also carry the turn's event log so the client can reconstruct the in-flight turn; when `running` is true but the log is absent (miss), the response SHALL carry `running: true` without the log. When `running` is false, the response SHALL be identical in shape to today's (full transcript replace). The added fields SHALL be optional so older clients ignore them without behavior change.

#### Scenario: sync during an in-flight turn replays the log

- **WHEN** a client sends `switch_session` for a session whose turn is in flight and the replay log is present
- **THEN** the `session_loaded` response SHALL include `running: true` and the ordered turn event log

#### Scenario: sync with a buffer miss reports running without a log

- **WHEN** a client sends `switch_session` for a session whose turn is in flight but the replay log is absent
- **THEN** the `session_loaded` response SHALL include `running: true` and no turn event log

#### Scenario: sync after the turn ended replaces the transcript

- **WHEN** a client sends `switch_session` for a session with no turn in flight
- **THEN** the `session_loaded` response SHALL include `running: false` and the full persisted transcript, as today

#### Scenario: older clients ignore the new fields

- **WHEN** a client that does not know `running`/turn-event fields receives the extended `session_loaded`
- **THEN** the client SHALL apply today's transcript-replace behavior without error
