## ADDED Requirements

### Requirement: Pending asks are held per session and restored on reconnect

The server SHALL hold at most one pending ask per dsh session, broadcast the question batch to that session's viewers when it arrives, and re-push the pending question during connection sync and session load so a reload or reconnect restores the card. The pending state SHALL be cleared when the ask is answered, cancelled, or failed.

#### Scenario: ask is broadcast to viewers

- **WHEN** an ask arrives for the session a client is viewing
- **THEN** the client receives the question batch associated with that session

#### Scenario: reload restores a pending card

- **WHEN** a client reloads or reconnects while an ask is still pending in the viewed session
- **THEN** the connection sync delivers the pending question so the card renders again

#### Scenario: resolution clears the pending state

- **WHEN** a pending ask is answered, cancelled, or failed
- **THEN** the per-session pending state is cleared and subsequent syncs deliver no pending question

### Requirement: Answer submissions are ownership-checked and first-wins

The server SHALL accept an answer or cancellation for a pending ask only from clients viewing the owning session. The first accepted submission SHALL resolve the ask; later submissions for the same ask SHALL have no effect on the outcome. Every viewer SHALL observe the final resolved state.

#### Scenario: an owning viewer answers

- **WHEN** a client viewing the session submits an answer for the pending ask
- **THEN** the answer is forwarded to the runtime and resolves the ask

#### Scenario: a late second submission is a no-op

- **WHEN** another surface already resolved the pending ask
- **THEN** the later submission changes nothing and the client's card converges to the final answered state

#### Scenario: a foreign client is rejected

- **WHEN** a client not viewing the owning session submits an answer
- **THEN** the submission is rejected without affecting the ask

### Requirement: Bot-session asks never reach the web transcript

An ask originating in a bot session SHALL be routed to that session's registered collector and SHALL NOT be broadcast to web viewers or stored as web-session pending state.

#### Scenario: bot ask stays in its channel

- **WHEN** an ask arrives for a bot session id
- **THEN** no web client receives a question event and no web pending state is created
