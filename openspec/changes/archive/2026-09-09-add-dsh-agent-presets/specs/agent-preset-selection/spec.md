## ADDED Requirements

### Requirement: The chat surface offers the dsh agent preset roster

The server SHALL expose the dsh agent preset roster (the four shipped modes
`standard` / `code` / `minimal` / `cordis` plus any user presets discovered
under the dsh user preset root) to the web client. Each roster entry SHALL
carry a stable `id`, a display `name`, a `description`, a `trust` mark
(`system` or `user`), and a `broken` flag with reason when the preset cannot
compose a session. Rows the roster marks `broken` SHALL be visible but not
selectable. The web app SHALL present a mode picker on the welcome (blank)
state (`data-testid="agent-preset-picker"`) listing every selectable preset
with name and description, and SHALL mark user-authored rows distinctly.

#### Scenario: roster rendered on the welcome state
- **WHEN** an authenticated client opens the chat with no active turn and the
  runtime is ready
- **THEN** the UI SHALL render the preset picker showing the four shipped
  modes (标准模式 / PTC 模式 / 极简模式 / 创造模式) and any user presets
- **AND** the currently selected preset SHALL be visually marked

#### Scenario: broken preset is shown but disabled
- **WHEN** the roster contains a preset whose composition is missing or
  unloadable
- **THEN** its row SHALL render with a failure indication and the reported
  reason and SHALL be disabled for selection

#### Scenario: deployment without a roster
- **WHEN** the runtime composes no agent-presets roster
- **THEN** the server SHALL answer `list_presets` with an empty list and the
  picker SHALL render nothing (no error, no blocking of chat)

### Requirement: Selecting a preset applies to the next session only

A preset choice is fixed when a session is created; dsh refuses to recompose a
session that has produced turns. The server SHALL apply a selected preset via
the bridge restart path (fresh dsh child `initialize` carrying the preset id),
SHALL reject `set_preset` while a turn is streaming (the same guard
`set_model` uses), and SHALL reject an unknown or broken preset id with an
`error` sent only to the requesting client. The selection SHALL be persisted
as a user preference so a server restart keeps it.

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

### Requirement: An active session shows its preset as a static label

Inside a non-blank session the header SHALL display the preset that session
runs as read-only chrome (`data-testid="agent-preset-label"`), never as a
live switch control. The label SHALL resolve the display name against the
roster and fall back to the preset id when the roster no longer supplies it.

#### Scenario: label reflects the running session
- **WHEN** a session is open
- **THEN** the header SHALL show that session's preset name (or the deployment
  default name when the session named none)
- **AND** interacting with the label SHALL NOT switch the running session's
  preset

### Requirement: WebSocket preset contract

The WebSocket protocol SHALL carry: server-to-client `presets`
(`{ presets, current }`) pushed on connect and after roster-invalidating
restarts, `current_preset` (`{ id }`) after a successful switch, and
client-to-server `list_presets` (roster fetch) and `set_preset` (`{ id }`).

#### Scenario: late-connecting client receives the roster
- **WHEN** a client connects after the runtime is ready
- **THEN** the connect-time sync SHALL include the current preset id and the
  client can obtain the full roster with `list_presets`

#### Scenario: preset-switch failure is visible
- **WHEN** the restart carrying the new preset fails
- **THEN** the server SHALL send an `error` to the requesting client and the
  previous preset SHALL remain reported as current
