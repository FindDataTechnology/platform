## MODIFIED Requirements

### Requirement: Composer renders a control strip beneath the input

The chat composer SHALL render its controls in a single row beneath the textarea, split into two clusters. The left cluster SHALL contain, in order: a `+` menu button whose menu offers file attachment and the commands entry, and the permission control. The right cluster SHALL contain, in order: the model control, the reasoning-effort control (when the active model renders one), an overflow menu (`⋯`) containing the workspace control (rendered in project semantics per `workspace-selection`, 工作目录控件以项目语义呈现), and the send/stop control as the rightmost element. The agent control is retired from the overflow menu: persona selection moves to the unified assistant selector「与谁对话」(openspec: agent-preset-selection, 统一的「与谁对话」选人面), and the overflow menu no longer carries an agent section. Every control SHALL be reachable by keyboard and SHALL carry an accessible label resolved through the i18n bundle. Existing control `data-testid` contracts SHALL be preserved by the restructuring.

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
- **THEN** the workspace control SHALL be offered inside the overflow menu, presented in project semantics (per `workspace-selection`)
- **AND** the overflow menu SHALL NOT contain an agent section (persona selection lives in the unified assistant selector)

#### Scenario: keyboard reach and labels are preserved

- **WHEN** the user navigates the composer with the keyboard
- **THEN** the `+` button, permission, model, effort, overflow, and send/stop controls SHALL each be focusable and carry accessible labels
- **AND** controls inside the `+` and overflow menus SHALL be reachable once their menu is open

### Requirement: Control strip is the sole surface for per-turn runtime configuration

The control strip SHALL be the only surface in the application from which the user changes the runtime configuration that applies to the next turn — workspace, model, and reasoning effort — together with the unified assistant selector「与谁对话」(openspec: agent-preset-selection) as the sole surface for persona/agent switching. No other component SHALL offer a control that mutates any of these values. Surfaces outside the strip and the assistant selector MAY display the active values for reference but SHALL NOT change them. Persistent configuration that is not per-turn — which LLM providers exist, which model is the startup default, which MCP servers and skills are registered — SHALL be configured in the Settings surface instead, and SHALL NOT appear in the strip.

#### Scenario: no duplicate model control exists elsewhere

- **WHEN** the application is rendered in any route
- **THEN** the only control that sends `set_model` SHALL be the strip's model control
- **AND** no sidebar, header, or menu surface SHALL offer a model-switching control

#### Scenario: no duplicate agent control exists elsewhere

- **WHEN** the application is rendered in any route
- **THEN** the only control that sends `set_agent` SHALL be the unified assistant selector「与谁对话」
- **AND** the strip's overflow menu and the sidebar SHALL NOT offer an agent selector

#### Scenario: persistent configuration is not offered in the strip

- **WHEN** the user opens the strip's model control
- **THEN** it SHALL offer only selection among the available models
- **AND** SHALL NOT offer provider creation, editing, deletion, or default-model assignment
