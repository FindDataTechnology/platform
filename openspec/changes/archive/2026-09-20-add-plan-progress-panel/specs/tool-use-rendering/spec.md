## MODIFIED Requirements

### Requirement: UI renders tool calls as collapsible blocks
The chat UI SHALL render each tool call as a collapsible block with the tool name in its header and the input and output in its body, replacing the previous one-line tool indicator. A `todo_write` call is the exception: because its whole-list snapshot is rendered as the plan surface (see `chat-plan-progress`), its block SHALL render as a single compact summary line naming the tool and the resulting counts (e.g. `更新了计划（3/6）`, localized), with the full arguments available only through the block's expand path. No other tool loses the generic block.

#### Scenario: tool call block shown while running
- **WHEN** the server sends a `tool_start` event for tool `bash`
- **THEN** the UI SHALL render a collapsible block with header indicating `bash` and a running state
- **AND** the body SHALL display the tool's input arguments

#### Scenario: tool call block updated on completion
- **WHEN** the server sends the matching `tool_end` event
- **THEN** the UI SHALL update the block to a completed state and append the tool's output to the body

#### Scenario: tool block is collapsible
- **WHEN** the user clicks the block header
- **THEN** the body SHALL toggle between collapsed and expanded

#### Scenario: todo_write renders as a summary line
- **WHEN** the assistant calls `todo_write` with a 6-item list of which 3 are completed
- **THEN** the transcript SHALL render one compact line naming the tool and the `3/6` counts instead of the generic block with raw JSON arguments
- **AND** the plan surface SHALL show the same list
