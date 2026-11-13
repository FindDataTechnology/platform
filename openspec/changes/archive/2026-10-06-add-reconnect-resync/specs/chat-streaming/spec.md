## ADDED Requirements

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
