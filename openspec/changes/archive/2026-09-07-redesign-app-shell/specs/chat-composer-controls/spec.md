## MODIFIED Requirements

### Requirement: Composer renders a control strip beneath the input

The chat composer SHALL render a control strip beneath the textarea containing, in order: a workspace control, an agent control, a model control, a reasoning-effort control, and a commands control. The strip SHALL be left-aligned and SHALL share its row with the attachment and send buttons. Every control SHALL be reachable by keyboard and SHALL carry an accessible label resolved through the i18n bundle.

#### Scenario: strip renders in a connected session

- **WHEN** the chat view is mounted and the WebSocket status is `connected`
- **THEN** the composer SHALL render the control strip beneath the textarea
- **AND** each control SHALL display the runtime's current value for that setting

#### Scenario: strip is disabled while disconnected

- **WHEN** the WebSocket status is not `connected`
- **THEN** every control in the strip SHALL be disabled
- **AND** the textarea SHALL remain editable so the user can continue drafting

#### Scenario: agent control renders in the strip

- **WHEN** the control strip renders in a connected session
- **THEN** the strip SHALL render an agent control between the workspace control and the model control
- **AND** the control SHALL display the name of the currently active agent
- **AND** the control SHALL offer every agent returned by the server's switchable-agent list

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

## ADDED Requirements

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
