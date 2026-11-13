## MODIFIED Requirements

### Requirement: Server accepts user prompts via WebSocket
The server SHALL accept JSON messages of type `prompt` over WebSocket and hand them to the turn dispatcher (`turn-dispatch`), which forwards them to the dsh agent session. The server SHALL track, per connection, the session that connection's client is viewing, and a prompt received from a connection SHALL be recorded into that connection's viewed session (`session-ownership`). The shared runtime executes one web turn at a time; this SHALL be enforced by the dispatcher (a prompt for another session while a turn is open is queued, never dispatched alongside it), not by the client's navigation pattern. The prompt SHALL carry its target session id explicitly through dispatch so a session switch between acceptance and dispatch cannot re-attribute it.

#### Scenario: User sends a prompt
- **WHEN** a WebSocket client sends `{ "type": "prompt", "text": "List files" }` and the runtime is idle
- **THEN** the server dispatches the prompt into the session that client is viewing and streams the response back
- **AND** the user message is recorded into that session

#### Scenario: User sends a prompt into the same session while it is streaming
- **WHEN** a WebSocket client sends a prompt for the session whose turn is already in flight
- **THEN** the server SHALL reject it with the in-flight error (`The agent is still responding`)

#### Scenario: User sends prompt while agent is streaming
- **WHEN** a WebSocket client views session B and sends a prompt while session A's turn is in flight
- **THEN** the server SHALL queue B's prompt and report `queued` to B's viewers (`turn-dispatch`)
- **AND** SHALL NOT dispatch it into the runtime until A's turn closes

#### Scenario: Two users viewing different sessions
- **WHEN** two connections view different sessions and the second sends a prompt
- **THEN** that prompt's user message and reply are recorded into the second connection's viewed session
- **AND** the first connection's viewed session transcript is unchanged

#### Scenario: Attribution survives a switch mid-dispatch
- **WHEN** a prompt for session A is accepted and another connection switches the live agent to session B before A's prompt reaches the runtime
- **THEN** A's prompt SHALL still execute in and be recorded into session A
