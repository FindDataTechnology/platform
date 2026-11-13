## ADDED Requirements

### Requirement: Composer renders a control strip beneath the input

The chat composer SHALL render a control strip beneath the textarea containing,
in order: a workspace control, a commands control, a model control, and a
reasoning-effort control. The strip SHALL be left-aligned and SHALL share its
row with the attachment and send buttons. Every control SHALL be reachable by
keyboard and SHALL carry an accessible label resolved through the i18n bundle.

#### Scenario: strip renders in a connected session

- **WHEN** the chat view is mounted and the WebSocket status is `connected`
- **THEN** the composer SHALL render the control strip beneath the textarea
- **AND** each control SHALL display the runtime's current value for that setting

#### Scenario: strip is disabled while disconnected

- **WHEN** the WebSocket status is not `connected`
- **THEN** every control in the strip SHALL be disabled
- **AND** the textarea SHALL remain editable so the user can continue drafting

### Requirement: Control strip renders store state without optimistic updates

Each control SHALL render the value held in the chat store and SHALL NOT apply a
selection to its own local state. Selecting a value SHALL emit the corresponding
client message and nothing else; the control SHALL update only when the server
broadcasts the resulting change.

#### Scenario: selection awaits server confirmation

- **WHEN** the user selects a different model in the model control
- **THEN** the client SHALL send `{ "type": "set_model", "id": "<id>" }`
- **AND** the control SHALL continue displaying the previous model until a
  `model_changed` broadcast is received
- **AND** SHALL then display the new model

#### Scenario: rejected change leaves the control unchanged

- **WHEN** the user selects a value and the server responds with an `error`
- **THEN** the control SHALL continue displaying the previous value
- **AND** the error SHALL be surfaced to the user

### Requirement: Control strip reports runtime restarts

The strip SHALL indicate when a runtime restart is in progress, and the composer
SHALL prevent sending until the runtime is healthy again. Model, effort, and
workspace changes all restart the dsh runtime, because dsh fixes that
configuration in the `initialize` handshake.

#### Scenario: restart is visible on the strip

- **WHEN** a control emits a change that restarts the dsh runtime
- **THEN** that control SHALL display a pending state until the corresponding
  change broadcast is received
- **AND** the send button SHALL be disabled for the duration

#### Scenario: send is re-enabled after restart

- **WHEN** the server broadcasts the change confirming the restart completed
- **THEN** the pending state SHALL clear
- **AND** the send button SHALL be re-enabled subject to its existing conditions

### Requirement: Commands control opens the existing slash-command picker

The commands control SHALL open the same `SlashCommandPicker` used by typed `/`
input, with an empty query, showing built-in commands and loaded skills in the
existing sections. Selecting an entry SHALL insert its token into the textarea
exactly as the typed path does. No second command list SHALL be maintained.

#### Scenario: clicking the commands control opens the picker

- **WHEN** the user activates the commands control
- **THEN** the slash-command picker SHALL open showing all built-in commands and
  all loaded skills
- **AND** keyboard navigation, filtering, and Escape-to-dismiss SHALL behave
  identically to the typed-`/` path

#### Scenario: selecting a command inserts its token

- **WHEN** the user selects an entry from the picker opened via the control
- **THEN** the entry's token SHALL be inserted into the textarea followed by a
  space
- **AND** focus SHALL return to the textarea

### Requirement: Reasoning-effort control appears only for models that support it

The effort control SHALL render only when the active model's `ModelInfo`
includes a non-empty `reasoningEfforts` array. When the field is absent or
empty, the control SHALL NOT be rendered.

#### Scenario: reasoning model shows the effort control

- **WHEN** the active model declares `reasoningEfforts: ["low","medium","high"]`
- **THEN** the strip SHALL render the effort control offering those three values
- **AND** SHALL display the currently active effort

#### Scenario: non-reasoning model omits the effort control

- **WHEN** the active model's `ModelInfo` has no `reasoningEfforts` field
- **THEN** the strip SHALL NOT render an effort control
- **AND** SHALL NOT render a disabled placeholder in its position

#### Scenario: switching to a non-reasoning model removes the control

- **WHEN** the active model changes to one without `reasoningEfforts`
- **THEN** the effort control SHALL be removed from the strip
