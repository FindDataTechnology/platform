## ADDED Requirements

### Requirement: Chat UI displays messages in a conversation view
The chat UI SHALL display user messages and assistant responses in a scrollable conversation area with distinct styling for each role.

#### Scenario: User sends a message
- **WHEN** the user types a message and submits it
- **THEN** the message SHALL appear in the conversation area with user styling (right-aligned, distinct background)

#### Scenario: Assistant responds with text
- **WHEN** the server sends text deltas for an assistant response
- **THEN** the text SHALL appear incrementally in the conversation area with assistant styling (left-aligned)

### Requirement: Chat UI shows tool execution status
The chat UI SHALL display tool execution start and end events inline with the conversation.

#### Scenario: Agent runs a tool
- **WHEN** the server sends a `tool_start` event
- **THEN** the UI SHALL display a tool indicator showing the tool name with a loading state
- **AND** when `tool_end` arrives, SHALL update the indicator to show success or error

### Requirement: Chat UI supports streaming text input
The chat UI SHALL provide a text input field with a send button and Enter key support for submitting prompts.

#### Scenario: User submits a prompt
- **WHEN** the user types text and presses Enter or clicks the Send button
- **THEN** the prompt SHALL be sent to the server via WebSocket and the input SHALL be cleared

#### Scenario: Empty input is rejected
- **WHEN** the user tries to submit an empty or whitespace-only message
- **THEN** the message SHALL NOT be sent

### Requirement: Chat UI handles WebSocket connection lifecycle
The chat UI SHALL connect to the WebSocket server on page load, display connection status, and reconnect on disconnect.

#### Scenario: Connection established
- **WHEN** the page loads and WebSocket connects successfully
- **THEN** the UI SHALL show a "Connected" status indicator

#### Scenario: Connection lost
- **WHEN** the WebSocket connection drops
- **THEN** the UI SHALL show a "Disconnected" status and attempt to reconnect after 2 seconds

### Requirement: Chat UI shows thinking blocks
The chat UI SHALL display thinking content from the agent in a collapsible block.

#### Scenario: Agent produces thinking output
- **WHEN** the server sends a `thinking` delta event
- **THEN** the UI SHALL display the thinking content in a collapsible, visually distinct block