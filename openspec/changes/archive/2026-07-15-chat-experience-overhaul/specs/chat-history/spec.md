## MODIFIED Requirements

### Requirement: Chat sessions are persisted to disk as the conversation progresses
The server SHALL persist each chat session using the pi SDK's persistent `SessionManager` as a JSONL session file under a configured sessions directory. The server SHALL track a current session in memory. The SDK SHALL persist conversation messages automatically as the turn progresses (on agent `message_end`); the server SHALL NOT additionally append messages to a parallel store. Each session SHALL expose an id, a title (derived from the first user message), creation timestamp, and update timestamp via the SDK's session metadata. Persistence SHALL remain atomic and crash-safe as provided by the SDK's append-only session store.

#### Scenario: user prompt is persisted
- **WHEN** the server receives a `prompt` WebSocket message for the current session
- **THEN** the SDK SHALL persist the user message to the current session's JSONL file
- **AND** the current session's update timestamp SHALL advance

#### Scenario: assistant turn is persisted on completion
- **WHEN** the agent turn completes (`done`)
- **THEN** the SDK SHALL persist the assistant's final message to the current session's JSONL file
- **AND** the session's update timestamp SHALL advance

#### Scenario: session title derived from first message
- **WHEN** a session receives its first user message
- **THEN** the server SHALL set the session's display name to a truncated form of that message

### Requirement: Users can list past chat sessions
The server SHALL expose an endpoint and a WebSocket message that return a list of persisted SDK sessions with their id, title, creation timestamp, update timestamp, and message count, ordered most-recently-updated first, sourced from the SDK's session list. The list SHALL NOT include full message bodies.

#### Scenario: list sessions
- **WHEN** a client requests the session list
- **THEN** the server SHALL return session metadata ordered by update timestamp descending
- **AND** SHALL NOT include message content in the list response

### Requirement: Users can start a new chat session
The server SHALL expose an endpoint and a WebSocket message to start a new chat session, which creates a new SDK session and makes it the current session. Subsequent prompts SHALL be appended to the new session. The previous session SHALL remain persisted and listed. Starting a new session SHALL be rejected while the agent is streaming.

#### Scenario: start a new session
- **WHEN** a client starts a new chat session and the agent is not streaming
- **THEN** the server SHALL create a new SDK session and make it the current session
- **AND** the previous session SHALL remain persisted and listed

#### Scenario: new session rejected while streaming
- **WHEN** a client starts a new chat session while the agent is streaming
- **THEN** the server SHALL reject the request with an error
- **AND** the current session SHALL remain unchanged

## REMOVED Requirements

### Requirement: Users can view a past session's messages read-only
**Reason**: Replaced by resumable sessions. Past sessions are now loaded into the live agent and continued, rather than viewed read-only with no resume.
**Migration**: Use the session-switch flow (sidebar click or `switch_session`) to load a past session into the live agent. Its messages render in the chat view and new turns continue that session.

## ADDED Requirements

### Requirement: Users can resume a past session into the live agent
The server SHALL allow a past session to be resumed into the live agent. Resuming a session SHALL load that session's message history into the agent's context so subsequent turns continue the conversation, and SHALL set it as the current session so new turns append to it. The server SHALL broadcast the loaded session's messages to clients so the chat view renders the resumed conversation.

#### Scenario: resume a session
- **WHEN** a client selects a past session to resume
- **THEN** the server SHALL load that session's message history into the agent's context
- **AND** SHALL set it as the current session
- **AND** SHALL broadcast the session's messages to clients for rendering

#### Scenario: resumed session continues the conversation
- **WHEN** the user sends a prompt after resuming a session
- **THEN** the agent SHALL respond with awareness of the resumed session's history
- **AND** the turn SHALL be appended to that session

### Requirement: Users can switch the active chat session
The server SHALL accept a `switch_session` WebSocket message and switch the live agent to the requested session by id using the SDK session manager's resume mechanism, broadcasting a `session_loaded` event carrying the session id, title, and message list. Switching SHALL be rejected while the agent is streaming. The active session SHALL be reflected as highlighted in the sidebar.

#### Scenario: switch to a session
- **WHEN** a client sends `switch_session` for a valid session id and the agent is not streaming
- **THEN** the server SHALL switch the live agent to that session
- **AND** SHALL broadcast `session_loaded` with that session's id, title, and messages

#### Scenario: switch rejected while streaming
- **WHEN** a client sends `switch_session` while the agent is streaming
- **THEN** the server SHALL send an error and the active session SHALL remain unchanged

#### Scenario: switch to an unknown session
- **WHEN** a client sends `switch_session` for an id that does not exist
- **THEN** the server SHALL send an error and the active session SHALL remain unchanged
