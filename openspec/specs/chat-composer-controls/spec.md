# chat-composer-controls Specification

## Purpose
The composer's control strip — the single row beneath the chat input and the only surface for per-turn runtime configuration: workspace, agent, model, reasoning effort, permission and the web-search toggle, plus the `+` menu for attachments and commands. Controls render store state only (no optimistic updates), report runtime restarts and block sending until the runtime is healthy, hide themselves when not applicable (effort without declared `reasoningEfforts`, agent with a single agent), reject agent switches mid-stream, and keep a 16px textarea on mobile to avoid iOS focus zoom.

## Requirements

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

The strip SHALL indicate when a runtime restart is in progress, and the composer SHALL prevent sending until the runtime is healthy again. Effort and workspace changes restart the dsh runtime, because dsh fixes that configuration in the `initialize` handshake. Model changes follow the bridge's declared capability: when the bridge declares the `model/set` RPC, a model switch applies live without re-spawning the runtime and without entering the pending state or disabling the send button (consistent with `model-selection`); when the bridge does not declare it, a model change takes the legacy restart path with the pending window. An agent change SHALL NOT restart the dsh runtime — the server switches the active catalog agent in place and broadcasts `agent_changed` without re-spawning the child — and SHALL therefore NOT put the strip into the pending state or disable the send button.

#### Scenario: restart is visible on the strip

- **WHEN** a control emits a change that restarts the dsh runtime (effort or workspace)
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

#### Scenario: live model switch does not enter the pending state

- **WHEN** the bridge declares the `model/set` capability and the user selects a different model (including mid-stream)
- **THEN** the strip SHALL NOT display a pending state for the model control and the send button SHALL remain available
- **AND** the active-model broadcast SHALL update the strip's model display

#### Scenario: bridge without model/set keeps the restart path

- **WHEN** the bridge does not declare the `model/set` capability and the user selects a different model
- **THEN** the model change SHALL behave as a runtime restart — pending state on the model control and send disabled until the change broadcast

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

### Requirement: Composer textarea uses 16px font on mobile viewports to prevent iOS focus zoom

The composer textarea SHALL render at a font size of at least 16px on viewports below the `md` breakpoint. Desktop viewports (`md` and above) SHALL keep the established 14px (`text-sm`) composer typography. The page SHALL NOT disable browser zoom via `maximum-scale` to work around iOS focus auto-zoom — the font-size floor is the only permitted mechanism.

#### Scenario: mobile focus does not zoom the viewport

- **WHEN** the page renders at a mobile viewport (below `md`, e.g. 390px wide) in an iOS browser (Safari or WeChat built-in) and the user focuses the composer textarea
- **THEN** the browser SHALL NOT auto-zoom the page (computed textarea font-size is ≥16px)

#### Scenario: desktop typography is unchanged

- **WHEN** the page renders at or above the `md` breakpoint
- **THEN** the composer textarea font size SHALL remain 14px (`text-sm`)

#### Scenario: browser zoom stays user-controllable

- **WHEN** the viewport meta is inspected
- **THEN** it SHALL NOT set `maximum-scale=1` or `user-scalable=no`

### Requirement: Web search toggle chip on the control strip

控制条 SHALL 提供会话级「联网搜索」开关芯片，默认关。开关 SHALL 经服务端 `tools/set` 路径即时生效（免重启），翻转后芯片 SHALL 反映该会话的当前状态；桥未声明 `tools/set` 能力时 SHALL 不渲染该芯片（而非渲染一个不可用开关）。

#### Scenario: 默认关闭

- **WHEN** 用户开启新会话
- **THEN** 联网搜索开关 SHALL 呈关闭态，该会话的 websearch 工具被闸

#### Scenario: 翻开即时生效

- **WHEN** 用户在流外翻开开关
- **THEN** 该会话后续回合 SHALL 可调用 websearch 工具，无重启、无禁发窗

#### Scenario: 无能力不渲染

- **WHEN** 桥能力声明不含 `tools/set`
- **THEN** 控制条 SHALL 不渲染联网开关芯片
