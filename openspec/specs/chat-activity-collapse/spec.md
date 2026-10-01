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
The collapsed group header SHALL NOT display tool names, file paths, or other machine identifiers. While the turn is streaming it SHALL show live progress as a step count; after the turn ends it SHALL show a final summary of thinking duration (when measurable client-side) and executed step count.

#### Scenario: Live header during streaming
- **WHEN** the third tool call is running in a streaming turn
- **THEN** the collapsed header SHALL indicate that step 3 is in progress

#### Scenario: Final header after completion
- **WHEN** a turn that had 2 seconds of thinking and 5 non-text steps completes
- **THEN** the collapsed header SHALL state the thinking duration and the step count, without any tool name

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
