# chat-history delta

## ADDED Requirements

### Requirement: Sessions carry a title that the user can rename
Each session SHALL have a `title` field that defaults to the first user message (truncated) but MAY be set by the user via a rename action. The server SHALL expose `PATCH /api/chat-history/sessions/:id` accepting `{ title }` (validated to a non-empty string ≤ 200 characters). On success, the server SHALL update the title in the project-database mirror and the on-disk store, and SHALL broadcast a `session_renamed` WebSocket event `{ id, title }` to all connected clients. The WS protocol SHALL also accept a `rename_session` client message with `{ id, title }` as an alternative to the REST route — both produce the same server-side effect. The existing title-derivation logic (truncate the first user message) is the default; the user can override it at any time.

#### Scenario: rename via REST
- **WHEN** the client sends `PATCH /api/chat-history/sessions/:id` with `{ title: "New name" }`
- **THEN** the server SHALL update the title in the project database and the on-disk store
- **AND** broadcast a `session_renamed` event
- **AND** return HTTP 200 with `{ ok: true }`

#### Scenario: rename via WS
- **WHEN** the client sends `{ type: "rename_session", id, title }`
- **THEN** the server SHALL perform the same update as the REST route
- **AND** broadcast the same `session_renamed` event

#### Scenario: empty title is rejected
- **WHEN** the client sends a rename with `title: ""` (or whitespace only)
- **THEN** the server SHALL return HTTP 400 with `{ error: "title must be non-empty" }`
- **AND** no change SHALL be made

#### Scenario: title too long is rejected
- **WHEN** the client sends a rename with `title` longer than 200 characters
- **THEN** the server SHALL return HTTP 400 with `{ error: "title must be 200 characters or fewer" }`
- **AND** no change SHALL be made
