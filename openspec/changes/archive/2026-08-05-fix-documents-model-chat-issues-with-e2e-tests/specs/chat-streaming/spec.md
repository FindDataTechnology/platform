## ADDED Requirements

### Requirement: Chat prompt submission does not throw errors
Submitting a chat prompt SHALL send the message over WebSocket and SHALL NOT throw JavaScript errors. The submit handler SHALL properly handle null or undefined references, check WebSocket connection state, and validate input before submission.

#### Scenario: submitting a valid prompt
- **WHEN** user types a valid message and clicks Send
- **THEN** the message SHALL be sent over the WebSocket
- **AND** no JavaScript error SHALL be thrown
- **AND** the input SHALL be disabled during streaming

#### Scenario: submitting with no WebSocket connection
- **WHEN** user submits a prompt when WebSocket is not connected
- **THEN** the UI SHALL show an error message
- **AND** SHALL NOT throw a JavaScript error
- **AND** the input SHALL remain enabled

### Requirement: Empty prompt submission is prevented
The UI SHALL prevent submission of empty or whitespace-only prompts. The send button SHALL be disabled when the input is empty.

#### Scenario: send button disabled for empty input
- **WHEN** the input is empty or contains only whitespace
- **THEN** the send button SHALL be disabled

#### Scenario: whitespace-only input not submitted
- **WHEN** user types only whitespace and tries to submit
- **THEN** no message SHALL be sent
- **AND** no error SHALL be thrown
