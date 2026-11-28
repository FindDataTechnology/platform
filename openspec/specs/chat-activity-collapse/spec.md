# chat-activity-collapse Specification

## Purpose

Presents an assistant turn's thinking, tool, skill, and command activity as a single master-collapsible group with a plain-language header, so non-programmer users see the answer rather than per-block machinery. Applies to both the web chat UI and the mini-program client.

## Requirements
### Requirement: Consecutive non-text blocks render as one activity group
The chat UI SHALL render every maximal run of consecutive thinking, tool, and skill blocks in an assistant turn as a single collapsible activity group. Text blocks SHALL always render outside any group, in their original position relative to the groups. Command blocks (user-invoked slash-command echoes) and error blocks SHALL also always render outside any group, since they are user-facing feedback rather than agent machinery.

#### Scenario: Typical turn groups all machinery
- **WHEN** an assistant turn produces a thinking block, three tool blocks, then a text block
- **THEN** the UI SHALL render one activity group followed by the text, and the text SHALL be visible without expanding anything

#### Scenario: Interleaved turn yields multiple groups
- **WHEN** an assistant turn produces blocks in the order tool, tool, text, tool, text
- **THEN** the UI SHALL render one group for the first two tool blocks and a second group for the third, with both text blocks visible outside the groups

#### Scenario: Command echo stays visible
- **WHEN** the user runs a slash command and the turn contains only the resulting command block
- **THEN** the command block SHALL render visible without any group, showing its message without expansion

#### Scenario: Per-block collapse survives inside the group
- **WHEN** the user expands an activity group
- **THEN** each thinking, tool, and skill block inside SHALL remain individually collapsible, retaining its existing header, status, and expand behavior

### Requirement: Activity groups default to collapsed
Activity groups SHALL be collapsed by default during streaming, after turn completion, and when replayed from session history, on both the web and mini-program surfaces.

#### Scenario: Group stays collapsed while streaming
- **WHEN** tools are executing during a streaming turn
- **THEN** their activity group SHALL render collapsed, with only the group header visible

#### Scenario: History replay stays collapsed
- **WHEN** a past session is loaded and a turn contains an activity group without errors
- **THEN** the group SHALL render collapsed

### Requirement: Collapsed header summarizes activity in plain language
The collapsed group header SHALL NOT display tool names, file paths, or other machine identifiers. While the turn is streaming it SHALL show live progress as a step count; after the turn ends it SHALL show a final summary of thinking duration (when measurable client-side) and executed step count. Every placeholder in the rendered summary SHALL be filled with its value in the active locale — no interpolation placeholder SHALL be displayed to the user.

#### Scenario: Live header during streaming
- **WHEN** the third tool call is running in a streaming turn
- **THEN** the collapsed header SHALL indicate that step 3 is in progress

#### Scenario: Final header after completion
- **WHEN** a turn that had 2 seconds of thinking and 5 non-text steps completes
- **THEN** the collapsed header SHALL state the thinking duration and the step count, with every placeholder filled, and without any tool name

#### Scenario: Expanded group hides the summary duplication
- **WHEN** the user expands a group
- **THEN** the header SHALL remain as the group's title bar and inner blocks SHALL render below it

### Requirement: Errored activity auto-expands its group
An activity group containing a block that finished with an error SHALL expand automatically, both when the error lands during a live turn and when replayed from history, so failures are never hidden behind a collapsed header.

#### Scenario: Tool error expands the group live
- **WHEN** a tool call inside a collapsed group finishes with an error during streaming
- **THEN** the group SHALL expand to reveal the errored block

#### Scenario: Errored group expands on history replay
- **WHEN** a past session is loaded and a turn's activity group contains an errored block
- **THEN** the group SHALL render expanded with the errored block visible

### Requirement: 待确认的动作提议自动展开其活动组

活动组中含有一个仍在等待用户确认或取消的 `propose_action` 调用（调用进行中，或其提议状态为 pending）时，该组 SHALL 自动展开，使动作确认卡在不展开任何折叠头的情况下可见；与「报错活动自动展开」「进行中的提问卡不折叠」同一条「绝不把用户要回答的东西藏在折叠头后面」规则。提议被执行、拒绝或过期后，该组 SHALL 恢复默认折叠行为，历史回放时该卡 SHALL 在展开后以已执行面呈现。`propose_action` 的识别 SHALL 按工具名后缀匹配（运行时的工具名为 `mcp__<server>__propose_action`），MUST NOT 依赖裸名全等。

#### Scenario: 待确认提议不折叠

- **WHEN** 一个助手回合的活动组包含一条 `mcp__actions__propose_action` 调用，其返回的提议状态为 pending
- **THEN** 该组渲染为展开，确认卡及其确认/取消按钮无需任何点击即可见，且该调用不以通用工具块呈现

#### Scenario: 已执行提议随组折叠

- **WHEN** 同一回合的提议状态为 executed
- **THEN** 该组默认折叠，用户展开后看到已执行面，不再出现确认按钮
