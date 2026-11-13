## MODIFIED Requirements

### Requirement: Selecting a preset applies to the next session only

A preset choice is fixed when a session is created; dsh refuses to recompose a
session that has produced turns. The server SHALL apply a selected preset via
the bridge restart path (fresh dsh child `initialize` carrying the preset id),
SHALL reject `set_preset` while a turn is streaming (the same guard
`set_model` uses), and SHALL reject an unknown or broken preset id with an
`error` sent only to the requesting client. That streaming rejection is
enforced by the unified streaming guard inside `switchPresetTo` — the same
gate every preset switch passes through (server/ws.js:837-843 → agent-session
`switchPresetTo`) — rather than a separate `set_preset`-case check. The
selection SHALL be persisted as a user preference so a server restart keeps it.

#### Scenario: pick a mode from the welcome state
- **WHEN** the user selects a different preset in the picker while no turn is
  streaming
- **THEN** the server SHALL persist the choice, restart the dsh runtime with
  the preset in `initialize`, and broadcast `current_preset`
- **AND** the composer SHALL show the same pending-configuration block it
  shows for a model switch

#### Scenario: pick rejected while streaming
- **WHEN** a `set_preset` message arrives while the agent is responding
- **THEN** the server SHALL leave the current preset unchanged and answer an
  error

#### Scenario: existing sessions keep their preset
- **WHEN** the user opens a session created under another preset
- **THEN** that session SHALL keep the composition it started with; the picker
  is not offered mid-session
