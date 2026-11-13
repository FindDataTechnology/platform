## ADDED Requirements

### Requirement: Server forwards tool input and output in tool events
The server SHALL include the tool's input arguments in `tool_start` events and the tool's result and error status in `tool_end` events, using the `args` and `result` fields already provided by the SDK's tool execution events.

#### Scenario: tool start includes input
- **WHEN** the agent begins executing a tool `bash` with arguments `{ "command": "ls" }`
- **THEN** the server SHALL send `{ "type": "tool_start", "name": "bash", "args": { "command": "ls" } }`

#### Scenario: tool end includes output
- **WHEN** the tool finishes and produces a result
- **THEN** the server SHALL send `{ "type": "tool_end", "name": "bash", "result": "<output>", "isError": false }`

#### Scenario: tool end includes error
- **WHEN** the tool finishes with an error
- **THEN** the server SHALL send `{ "type": "tool_end", "name": "bash", "result": "<error output>", "isError": true }`

### Requirement: UI renders tool calls as collapsible blocks
The chat UI SHALL render each tool call as a collapsible block with the tool name in its header and the input and output in its body, replacing the previous one-line tool indicator.

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

### Requirement: UI renders tool errors with distinct styling
The chat UI SHALL visually distinguish tool calls that ended in error from successful ones.

#### Scenario: errored tool call displayed
- **WHEN** a `tool_end` event arrives with `isError: true`
- **THEN** the block SHALL be styled with the error appearance and the body SHALL show the error output

### Requirement: Tool output blocks are scroll-bounded
The chat UI SHALL constrain the height of a tool block's body so that large outputs do not dominate the conversation, while remaining scrollable.

#### Scenario: large tool output
- **WHEN** a tool produces output exceeding the body's maximum height
- **THEN** the body SHALL scroll within a bounded max-height rather than expanding the whole block
