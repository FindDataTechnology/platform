## MODIFIED Requirements

### Requirement: Agent switching is rejected while the agent is streaming

The agent control — since the strip's agent section is retired, the unified assistant selector「与谁对话」（the AssistantPicker in its `welcome` and session-`header` placements; openspec: agent-preset-selection）— SHALL follow the same streaming guard as the model control. The server SHALL reject a `set_agent` request while a turn is mid-response, so that a turn is not interrupted by an agent switch, and the selector SHALL surface the resulting error without changing the displayed agent.

#### Scenario: agent switch attempted during streaming

- **WHEN** the user selects a different agent while the agent is streaming a response
- **THEN** the server SHALL reply with an `error` indicating the agent cannot be changed mid-turn
- **AND** the assistant selector SHALL continue displaying the previous agent

#### Scenario: agent control is disabled while streaming

- **WHEN** a turn is streaming
- **THEN** the assistant selector's persona rows SHALL be disabled
- **AND** SHALL be re-enabled when the turn ends, whether it succeeded or failed

### Requirement: Agent control renders only when a switch is possible

The agent control — the persona face of the unified assistant selector「与谁对话」（the AssistantPicker in its `welcome` and session-`header` placements; openspec: agent-preset-selection）— SHALL render only when two or more switchable agents exist. When the deployment has a single agent — the default, since the catalog is optional — the selector SHALL NOT render a persona choice (the single local agent SHALL NOT appear as a selectable persona row) rather than rendered showing one unchangeable value.

Because the agent list arrives asynchronously after connect, the control MAY appear once the catalog loads. This settling is permitted; it matches how the model control's list populates at startup.

#### Scenario: single agent omits the control

- **WHEN** the chat renders in a deployment with no catalog configured, so only the local agent exists
- **THEN** the assistant selector SHALL NOT render a persona choice
- **AND** the control strip SHALL NOT render an agent control

#### Scenario: multiple agents render the control

- **WHEN** the catalog provides two or more switchable agents
- **THEN** the assistant selector SHALL render the persona choice
- **AND** it SHALL list every switchable agent
