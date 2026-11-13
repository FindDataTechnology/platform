## MODIFIED Requirements

### Requirement: Server accepts user prompts via WebSocket
The server SHALL accept JSON messages of type `prompt` over WebSocket and forward them to the dsh agent session. The server SHALL track, per connection, the session that connection's client is viewing, and a prompt received from a connection SHALL be recorded into that connection's viewed session (`session-ownership`); the shared runtime still executes one turn at a time.

#### Scenario: User sends a prompt
- **WHEN** a WebSocket client sends `{ "type": "prompt", "text": "List files" }`
- **THEN** the server calls `session.prompt("List files")` and streams the response back
- **AND** the user message is recorded into the session that client is viewing

#### Scenario: User sends prompt while agent is streaming
- **WHEN** a WebSocket client sends a prompt while the agent is already processing
- **THEN** the server SHALL queue the prompt using `steer` behavior

#### Scenario: Two users viewing different sessions

- **WHEN** two connections view different sessions and the second sends a prompt
- **THEN** that prompt's user message and reply are recorded into the second connection's viewed session
- **AND** the first connection's viewed session transcript is unchanged
