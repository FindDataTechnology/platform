## MODIFIED Requirements

### Requirement: session_loaded carries turn-in-flight status and replay payload

The `session_loaded` response to `switch_session` SHALL include a `running` boolean derived from the server's turn-origin state (`running: true` only when a turn is in flight for the target session). When `running` is true and the replay log is present, the response SHALL also carry the turn's event log so the client can reconstruct the in-flight turn; when `running` is true but the log is absent (miss), the response SHALL carry `running: true` without the log.

When `running` is false, the response SHALL carry a transcript **window** — at most the most recent N turns — together with `totalTurns` and a `hasMore` boolean, rather than the entire transcript. N SHALL be a single constant shared with the client's render window. The response MUST NOT grow linearly with session length in its first frame. The added fields SHALL be optional so older clients ignore them without error: an older client that ignores `hasMore`/`totalTurns` SHALL still receive a valid transcript window and apply its existing replace behavior to it.

#### Scenario: sync during an in-flight turn replays the log

- **WHEN** a client sends `switch_session` for a session whose turn is in flight and the replay log is present
- **THEN** the `session_loaded` response SHALL include `running: true` and the ordered turn event log

#### Scenario: sync with a buffer miss reports running without a log

- **WHEN** a client sends `switch_session` for a session whose turn is in flight but the replay log is absent
- **THEN** the `session_loaded` response SHALL include `running: true` and no turn event log

#### Scenario: sync after the turn ended replaces the transcript

- **WHEN** a client sends `switch_session` for a session with no turn in flight whose transcript has more turns than N
- **THEN** the response SHALL include `running: false` and replace the view with at most the most recent N turns
- **AND** it SHALL include `totalTurns` and `hasMore: true`
- **AND** the first frame's size SHALL NOT scale with the full transcript length

#### Scenario: a short session's window is the whole transcript

- **WHEN** a client sends `switch_session` for a session whose transcript has at most N turns
- **THEN** the response SHALL include the whole transcript with `hasMore: false`

#### Scenario: older clients ignore the new fields

- **WHEN** a client that does not know `running`/turn-event/`hasMore`/`totalTurns` fields receives the extended `session_loaded`
- **THEN** the client SHALL apply its transcript-replace behavior to the received window without error

## ADDED Requirements

### Requirement: Earlier transcript pages load on demand

The server SHALL serve earlier turns of a session on request, so a client can page backwards through a long transcript without holding it all in memory. The request SHALL carry the session id and a cursor naming the earliest already-loaded turn (by `seq`); the response SHALL carry the preceding batch of turns in ascending order and a `hasMore` boolean. The request SHALL respect the same session ownership/access rules as `switch_session`. An unknown session or a cursor with no earlier turns SHALL be answered honestly (empty page with `hasMore: false`, or an error), never with a fabricated page.

#### Scenario: paging backwards returns the previous batch

- **WHEN** a client requests earlier turns for a session, giving the seq of its earliest loaded turn
- **THEN** the response SHALL return the preceding batch of turns in ascending order and `hasMore` reflecting whether even earlier turns exist

#### Scenario: oldest page ends the paging

- **WHEN** a client requests earlier turns naming the session's first turn as the cursor
- **THEN** the response SHALL be an empty page with `hasMore: false`

#### Scenario: ownership is enforced on paging

- **WHEN** a client requests earlier turns for a session it is not entitled to
- **THEN** the request SHALL be refused exactly as `switch_session` refuses it
