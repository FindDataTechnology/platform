## MODIFIED Requirements

### Requirement: Chat sessions are mirrored to the project database as the conversation progresses
The server SHALL mirror each chat session's user prompts and assistant responses into the project SQLite database (managed by `project-database`) as the conversation progresses - the user message on `prompt` and the assistant's final message on turn completion (`done`). The project database SHALL be the store of record for the session list and read-only view APIs. The pi SDK's file-based `SessionManager` (JSONL under `sessions-store/`) SHALL remain the live agent's context store and the source for resume/switch, as a sealed SDK constraint; the server SHALL keep the SQLite mirror in sync as turns progress. The server SHALL track a current session in memory. Each session SHALL expose an id, a title (derived from the first user message), creation timestamp, and update timestamp. SQLite writes SHALL be atomic and crash-safe via transactions.

#### Scenario: user prompt is persisted
- **WHEN** the server receives a `prompt` WebSocket message for the current session
- **THEN** the server SHALL persist the user message to the project database for the current session
- **AND** the current session's update timestamp SHALL advance

#### Scenario: assistant turn is persisted on completion
- **WHEN** the agent turn completes (`done`)
- **THEN** the server SHALL persist the assistant's final message to the project database for the current session
- **AND** the session's update timestamp SHALL advance

#### Scenario: session title derived from first message
- **WHEN** a session receives its first user message
- **THEN** the server SHALL set the session's display name to a truncated form of that message

### Requirement: Users can list past chat sessions
The server SHALL expose an endpoint and a WebSocket message that return a list of persisted chat sessions with their id, title, creation timestamp, update timestamp, and message count, ordered most-recently-updated first, sourced from the project SQLite database. The list SHALL NOT include full message bodies.

#### Scenario: list sessions
- **WHEN** a client requests the session list
- **THEN** the server SHALL return session metadata ordered by update timestamp descending
- **AND** SHALL NOT include message content in the list response
