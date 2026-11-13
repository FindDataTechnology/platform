## MODIFIED Requirements

### Requirement: Users can start a new chat session
The server SHALL expose an endpoint, a `new_session` WebSocket message, AND a `/new` chat command to start a new chat session, each of which creates a new SDK session and makes it the current session. Subsequent prompts SHALL be appended to the new session. The previous session SHALL remain persisted and listed. Starting a new session SHALL be rejected while the agent is streaming. The server SHALL broadcast a refreshed session list after a new session is created.

#### Scenario: start a new session via the button
- **WHEN** a client starts a new chat session (button or `new_session` message) and the agent is not streaming
- **THEN** the server SHALL create a new SDK session and make it the current session
- **AND** the previous session SHALL remain persisted and listed

#### Scenario: start a new session via the /new command
- **WHEN** a client sends `{ "type": "prompt", "text": "/new" }` and the agent is not streaming
- **THEN** the server SHALL create a new SDK session and make it the current session
- **AND** SHALL broadcast a `command_use` event for the `new` command
- **AND** SHALL broadcast a refreshed session list

#### Scenario: new session rejected while streaming
- **WHEN** a client starts a new chat session while the agent is streaming
- **THEN** the server SHALL reject the request with an error
- **AND** the current session SHALL remain unchanged

## ADDED Requirements

### Requirement: Session list refreshes after every turn end
The server SHALL broadcast a refreshed session list whenever an agent turn ends, whether the turn succeeded or failed, so that a newly created session appears in the sidebar even when its first turn errors. The list SHALL also be broadcast when a client connects and when a session is created or switched.

#### Scenario: session list refreshes after a failed turn
- **WHEN** an agent turn ends with an error
- **THEN** the server SHALL broadcast a refreshed session list
- **AND** any session created during that turn SHALL appear in the list
