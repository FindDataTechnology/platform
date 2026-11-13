## ADDED Requirements

### Requirement: Chat sessions are persisted to disk as the conversation progresses
The server SHALL persist each chat session as a JSON file under a chat-history store directory. The server SHALL track a current session in memory and SHALL append the user's message when a `prompt` is received and the assistant's final text when the agent turn completes (`done`). Each session record SHALL contain an id, a title (derived from the first user message), creation timestamp, update timestamp, and a message list. Persistence SHALL use atomic writes (temp file + rename).

#### Scenario: user prompt is persisted
- **WHEN** the server receives a `prompt` WebSocket message
- **THEN** the server SHALL append the user's message to the current session's message list
- **AND** SHALL persist the updated session to disk atomically

#### Scenario: assistant turn is persisted on completion
- **WHEN** the agent turn completes (`done`)
- **THEN** the server SHALL append the assistant's final text to the current session's message list
- **AND** SHALL update the session's update timestamp and persist atomically

#### Scenario: session title derived from first message
- **WHEN** a session receives its first user message
- **THEN** the server SHALL set the session title to a truncated form of that message

### Requirement: Users can list past chat sessions
The server SHALL expose an endpoint that returns a list of persisted sessions with their id, title, creation timestamp, and update timestamp, ordered most-recently-updated first. The list SHALL NOT include full message bodies.

#### Scenario: list sessions
- **WHEN** a client calls the session list endpoint
- **THEN** the server SHALL return session metadata ordered by update timestamp descending
- **AND** SHALL NOT include message content in the list response

### Requirement: Users can view a past session's messages read-only
The server SHALL expose an endpoint that returns a single session's full message list by id. The Chat History tab SHALL render a session's messages read-only. The UI SHALL NOT offer to resume a past session into the live agent.

#### Scenario: view a session
- **WHEN** a client opens a session in the Chat History tab
- **THEN** the UI SHALL fetch and render that session's messages in order
- **AND** SHALL NOT provide a resume action

#### Scenario: session not found
- **WHEN** a client requests a non-existent session id
- **THEN** the server SHALL return a not-found error

### Requirement: Users can start a new chat session
The server SHALL expose an endpoint to start a new chat session, which becomes the current session. Subsequent prompts SHALL be appended to the new session. The previous session SHALL remain persisted and viewable in history.

#### Scenario: start a new session
- **WHEN** a client calls the new-session endpoint
- **THEN** the server SHALL create a new empty session and make it the current session
- **AND** the previous session SHALL remain in history
