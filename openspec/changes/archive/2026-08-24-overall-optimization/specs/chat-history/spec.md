## MODIFIED Requirements

### Requirement: Chat sessions are mirrored to the project database as the conversation progresses
The server SHALL mirror each chat session's user prompts and assistant responses into the project SQLite database (managed by `project-database`) as the conversation progresses - the user message on `prompt` and the assistant's final message on turn completion (`done`). This SHALL apply to **both local dsh agent turns and remote (catalog `agent-remote`) agent turns**: remote turns (streamed via `streamRemoteChat`) SHALL be persisted on stream completion via the same `recordMessage()` path as local turns, so a browser close/reopen does not leave a dangling user message with no reply. The project database SHALL be the store of record for the session list and read-only view APIs. The dsh runtime persists sessions by id to its own disk store; the server SHALL keep the SQLite mirror in sync as turns progress. The server SHALL track a current session in memory. Each session SHALL expose an id, a title (derived from the first user message), creation timestamp, and update timestamp. SQLite writes SHALL be atomic and crash-safe via transactions.

#### Scenario: user prompt is persisted
- **WHEN** the server receives a `prompt` WebSocket message for the current session
- **THEN** the server SHALL persist the user message to the project database for the current session
- **AND** the current session's update timestamp SHALL advance

#### Scenario: assistant turn is persisted on completion
- **WHEN** the agent turn completes (`done`)
- **THEN** the server SHALL persist the assistant's final message to the project database for the current session
- **AND** the session's update timestamp SHALL advance

#### Scenario: remote agent turn is persisted on completion
- **WHEN** a remote (catalog `agent-remote`) turn completes
- **THEN** the server SHALL persist the assistant's final aggregated text to the project database for the current session via `recordMessage()`
- **AND** the session's update timestamp SHALL advance
- **AND** a browser close/reopen SHALL show both the user message and the remote assistant reply

#### Scenario: session title derived from first message
- **WHEN** a session receives its first user message
- **THEN** the server SHALL set the session's display name to a truncated form of that message
