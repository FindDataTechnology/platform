# chat-composer-controls Specification

## Purpose
TBD — created by archiving change composer-control-strip. Update Purpose after archive.

## Requirements

### Requirement: Composer renders a control strip beneath the input
The chat composer SHALL render its controls in a single row beneath the textarea, split into two clusters. The left cluster SHALL contain, in order: a `+` menu button whose menu offers file attachment and the commands entry, and the permission control. The right cluster SHALL contain, in order: the model control, the reasoning-effort control (when the active model renders one), an overflow menu (`⋯`) containing the workspace control and the agent control, and the send/stop control as the rightmost element. Every control SHALL be reachable by keyboard and SHALL carry an accessible label resolved through the i18n bundle. Existing control `data-testid` contracts SHALL be preserved by the restructuring.

#### Scenario: strip renders in a connected session
- **WHEN** the chat view is mounted and the WebSocket status is `connected`
- **THEN** the composer SHALL render the single control row beneath the textarea with the left and right clusters in the stated order
- **AND** each control SHALL display the runtime's current value for that setting
- **AND** the send/stop control SHALL be the rightmost control in the row

#### Scenario: strip is disabled while disconnected
- **WHEN** the WebSocket status is not `connected`
- **THEN** every control in the row SHALL be disabled
- **AND** the textarea SHALL remain editable so the user can continue drafting

#### Scenario: agent control renders in the strip
- **WHEN** the control row renders in a connected session
- **THEN** the workspace control SHALL be offered inside the overflow menu
- **AND** the agent control SHALL be offered inside the same overflow menu whenever two or more switchable agents exist, displaying the name of the currently active agent
- **AND** the agent control SHALL offer every agent returned by the server's switchable-agent list

#### Scenario: keyboard reach and labels are preserved
- **WHEN** the user navigates the composer with the keyboard
- **THEN** the `+` button, permission, model, effort, overflow, and send/stop controls SHALL each be focusable and carry accessible labels
- **AND** controls inside the `+` and overflow menus SHALL be reachable once their menu is open

### Requirement: Control strip renders store state without optimistic updates

Each control SHALL render the value held in the chat store and SHALL NOT apply a selection to its own local state. Selecting a value SHALL emit the corresponding client message and nothing else; the control SHALL update only when the server broadcasts the resulting change.

#### Scenario: selection awaits server confirmation

- **WHEN** the user selects a different model in the model control
- **THEN** the client SHALL send `{ "type": "set_model", "id": "<id>" }`
- **AND** the control SHALL continue displaying the previous model until a `model_changed` broadcast is received
- **AND** SHALL then display the new model

#### Scenario: agent selection awaits server confirmation

- **WHEN** the user selects a different agent in the agent control
- **THEN** the client SHALL send `{ "type": "set_agent", "id": "<id>" }`
- **AND** the control SHALL continue displaying the store's `currentAgent` until an `agent_changed` broadcast is received
- **AND** SHALL then display the new agent

#### Scenario: rejected change leaves the control unchanged

- **WHEN** the user selects a value and the server responds with an `error`
- **THEN** the control SHALL continue displaying the previous value
- **AND** the error SHALL be surfaced to the user

### Requirement: Control strip reports runtime restarts

The strip SHALL indicate when a runtime restart is in progress, and the composer SHALL prevent sending until the runtime is healthy again. Model, effort, and workspace changes all restart the dsh runtime, because dsh fixes that configuration in the `initialize` handshake. An agent change SHALL NOT restart the dsh runtime — the server switches the active catalog agent in place and broadcasts `agent_changed` without re-spawning the child — and SHALL therefore NOT put the strip into the pending state or disable the send button.

#### Scenario: restart is visible on the strip

- **WHEN** a control emits a change that restarts the dsh runtime
- **THEN** that control SHALL display a pending state until the corresponding change broadcast is received
- **AND** the send button SHALL be disabled for the duration

#### Scenario: send is re-enabled after restart

- **WHEN** the server broadcasts the change confirming the restart completed
- **THEN** the pending state SHALL clear
- **AND** the send button SHALL be re-enabled subject to its existing conditions

#### Scenario: agent change does not enter the pending state

- **WHEN** the user selects a different agent and the server broadcasts `agent_changed`
- **THEN** the strip SHALL NOT display a pending state for the agent control
- **AND** the send button SHALL NOT be disabled on account of the agent change

### Requirement: Commands control opens the existing slash-command picker
The `+` menu's commands entry SHALL trigger the same `SlashCommandPicker` used by typed `/` input, showing built-in commands and loaded skills in the existing sections. Selecting an entry SHALL insert its token into the textarea exactly as the typed path does. The `+` menu's attachment entry SHALL open the same file-selection and upload path the attachment button previously offered. No second command list or second upload path SHALL be maintained.

#### Scenario: plus menu offers attachment and commands
- **WHEN** the user activates the `+` button
- **THEN** the menu SHALL offer a file-attachment entry and a commands entry
- **AND** activating the attachment entry SHALL open the file selection dialog feeding the existing upload path

#### Scenario: clicking the commands control opens the picker
- **WHEN** the user activates the commands entry
- **THEN** the slash-command picker SHALL open showing all built-in commands and all loaded skills
- **AND** keyboard navigation, filtering, and Escape-to-dismiss SHALL behave identically to the typed-`/` path

#### Scenario: selecting a command inserts its token
- **WHEN** the user selects an entry from the picker opened via the menu
- **THEN** the entry's token SHALL be inserted into the textarea followed by a space
- **AND** focus SHALL return to the textarea

### Requirement: Reasoning-effort control appears only for models that support it

The effort control SHALL render only when the active model's `ModelInfo` includes a non-empty `reasoningEfforts` array. When the field is absent or empty, the control SHALL NOT be rendered.

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

### Requirement: Control strip is the sole surface for per-turn runtime configuration

The control strip SHALL be the only surface in the application from which the user changes the runtime configuration that applies to the next turn — workspace, agent, model, and reasoning effort. No other component SHALL offer a control that mutates any of these values. Surfaces outside the strip MAY display the active values for reference but SHALL NOT change them. Persistent configuration that is not per-turn — which LLM providers exist, which model is the startup default, which MCP servers and skills are registered — SHALL be configured in the Settings surface instead, and SHALL NOT appear in the strip.

#### Scenario: no duplicate model control exists elsewhere

- **WHEN** the application is rendered in any route
- **THEN** the only control that sends `set_model` SHALL be the strip's model control
- **AND** no sidebar, header, or menu surface SHALL offer a model-switching control

#### Scenario: no duplicate agent control exists elsewhere

- **WHEN** the application is rendered in any route
- **THEN** the only control that sends `set_agent` SHALL be the strip's agent control
- **AND** the sidebar SHALL NOT render an agent selector

#### Scenario: persistent configuration is not offered in the strip

- **WHEN** the user opens the strip's model control
- **THEN** it SHALL offer only selection among the available models
- **AND** SHALL NOT offer provider creation, editing, deletion, or default-model assignment

### Requirement: Agent switching is rejected while the agent is streaming

The agent control SHALL follow the same streaming guard as the model control. The server SHALL reject a `set_agent` request while a turn is mid-response, so that a turn is not interrupted by an agent switch, and the strip SHALL surface the resulting error without changing the displayed agent.

#### Scenario: agent switch attempted during streaming

- **WHEN** the user selects a different agent while the agent is streaming a response
- **THEN** the server SHALL reply with an `error` indicating the agent cannot be changed mid-turn
- **AND** the agent control SHALL continue displaying the previous agent

#### Scenario: agent control is disabled while streaming

- **WHEN** a turn is streaming
- **THEN** the agent control SHALL be disabled
- **AND** SHALL be re-enabled when the turn ends, whether it succeeded or failed

### Requirement: Agent control renders only when a switch is possible

The agent control SHALL render only when two or more switchable agents exist. When the deployment has a single agent — the default, since the catalog is optional — the control SHALL be omitted from the strip rather than rendered showing one unchangeable value.

Because the agent list arrives asynchronously after connect, the control MAY appear once the catalog loads. This settling is permitted; it matches how the model control's list populates at startup.

#### Scenario: single agent omits the control

- **WHEN** the chat renders in a deployment with no catalog configured, so only the local agent exists
- **THEN** the control strip SHALL NOT render an agent control
- **AND** the strip SHALL render its remaining controls without a gap where the agent control would be

#### Scenario: multiple agents render the control

- **WHEN** the catalog provides two or more switchable agents
- **THEN** the control strip SHALL render the agent control
- **AND** it SHALL list every switchable agent
