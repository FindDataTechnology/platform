## ADDED Requirements

### Requirement: Sessions record their owner

The session mirror SHALL stamp the authenticated owner (see `session-ownership`) on a session when its first turn is mirrored and SHALL NOT change it afterwards. The underlying storage change SHALL be an additive migration; sessions created before this capability are assigned to the deploy-designated owner account by that migration.

#### Scenario: first turn stamps the owner

- **WHEN** a new session's first user turn is mirrored from `alice@example.com`'s connection
- **THEN** the session record carries `alice@example.com` as its owner

#### Scenario: pre-existing sessions are assigned

- **WHEN** the additive migration runs
- **THEN** every pre-existing session row carries the deploy-designated owner

## MODIFIED Requirements

### Requirement: Users can list past chat sessions
The server SHALL expose an endpoint and a WebSocket message that return a list of persisted chat sessions with their id, title, creation timestamp, update timestamp, and message count, ordered most-recently-updated first, sourced from the project SQLite database. The list SHALL NOT include full message bodies. The list SHALL be scoped to the requesting user's visibility: only sessions that user owns, except admin-group users who receive all sessions (see `session-ownership`). The `sessions` WebSocket event SHALL be computed per connection from that connection's visibility — one broadcast never carries one user's session metadata to another user's client.

#### Scenario: list sessions
- **WHEN** a client requests the session list
- **THEN** the server SHALL return session metadata ordered by update timestamp descending
- **AND** SHALL NOT include message content in the list response
- **AND** SHALL include only sessions the requesting user is entitled to see

#### Scenario: each connection's list reflects its own user
- **WHEN** two clients of different users are connected and a list refresh is delivered
- **THEN** each client's `sessions` event contains only its own user's visible sessions

### Requirement: Users can switch the active chat session
The server SHALL accept a `switch_session` WebSocket message and switch the live agent to the requested session by id using the SDK session manager's resume mechanism, delivering a `session_loaded` event carrying the session id, title, and message list to the requesting connection and any other connection viewing that session (per-viewer delivery, `session-ownership`). Switching SHALL be rejected while the agent is streaming. The request SHALL be rejected with an access error when the requester neither owns the session nor is an admin-group user. The active session SHALL be reflected as highlighted in the sidebar.

#### Scenario: switch to a session
- **WHEN** a client sends `switch_session` for a valid session id it owns and the agent is not streaming
- **THEN** the server SHALL switch the live agent to that session
- **AND** SHALL deliver `session_loaded` with that session's id, title, and messages to the requesting connection and same-session viewers

#### Scenario: switch rejected while streaming
- **WHEN** a client sends `switch_session` while the agent is streaming
- **THEN** the server SHALL send an error and the active session SHALL remain unchanged

#### Scenario: switch to an unknown session
- **WHEN** a client sends `switch_session` for an id that does not exist
- **THEN** the server SHALL send an error and the active session SHALL remain unchanged

#### Scenario: switch to a session the requester does not own
- **WHEN** a client sends `switch_session` for a session owned by a different, non-admin user
- **THEN** the server SHALL send an access error and the active session SHALL remain unchanged

### Requirement: Server exposes a session delete endpoint
The server SHALL expose `DELETE /api/chat-history/sessions/:id` to remove a session by id. The server SHALL delete the on-disk session store file (atomic temp-file + rename, matching the existing write pattern) AND delete the mirror row in the project database (managed by `project-database`). After a successful delete, the server SHALL deliver a refreshed `sessions` WebSocket event to every connected client, each computed from that client's user visibility. A request for a non-existent id SHALL return 404. A request for the current session id SHALL be rejected with 409 and a clear error (`Cannot delete the active session; switch first`). A request for a session the requester neither owns nor is admin for SHALL be rejected with 403 and remove nothing. The dsh runtime's own session persistence (sessions stored by id on disk by dsh itself) SHALL also be removed so reopening the dsh session does not resurrect the deleted entry.

#### Scenario: delete a non-active session
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for a session it owns that is not the current one
- **THEN** the server SHALL remove the on-disk file and the database row
- **AND** deliver a `sessions` event with the refreshed list to every client (each scoped to its user)
- **AND** return HTTP 200 with `{ ok: true }`

#### Scenario: delete the active session is rejected
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for the current session
- **THEN** the server SHALL return HTTP 409 with `{ error: "Cannot delete the active session; switch first" }`
- **AND** no data SHALL be removed

#### Scenario: delete a non-existent session
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for an id that does not exist
- **THEN** the server SHALL return HTTP 404 with `{ error: "session not found" }`

#### Scenario: delete a session the requester does not own
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for a session owned by a different, non-admin user
- **THEN** the server SHALL return HTTP 403 and no data SHALL be removed

#### Scenario: delete broadcasts refreshed list
- **WHEN** a delete completes
- **THEN** every connected WebSocket client SHALL receive a `sessions` event whose `sessions[]` array does not include the deleted id and matches that client's user visibility

### Requirement: Sessions carry a title that the user can rename
Each session SHALL have a `title` field that defaults to the first user message (truncated) but MAY be set by the user via a rename action. The server SHALL expose `PATCH /api/chat-history/sessions/:id` accepting `{ title }` (validated to a non-empty string ≤ 200 characters). On success, the server SHALL update the title in the project-database mirror and the on-disk store, and SHALL deliver a `session_renamed` WebSocket event `{ id, title }` to the connections viewing that session. The WS protocol SHALL also accept a `rename_session` client message with `{ id, title }` as an alternative to the REST route — both produce the same server-side effect and the same ownership gate: a rename from a requester who neither owns the session nor is admin SHALL be rejected with an access error (REST 403) and change nothing. The existing title-derivation logic (truncate the first user message) is the default; the user can override it at any time.

#### Scenario: rename via REST
- **WHEN** the client sends `PATCH /api/chat-history/sessions/:id` with `{ title: "New name" }` for a session it owns
- **THEN** the server SHALL update the title in the project database and the on-disk store
- **AND** deliver a `session_renamed` event to the session's viewers
- **AND** return HTTP 200 with `{ ok: true }`

#### Scenario: rename via WS
- **WHEN** the client sends `{ type: "rename_session", id, title }` for a session it owns
- **THEN** the server SHALL perform the same update as the REST route
- **AND** deliver the same `session_renamed` event to the session's viewers

#### Scenario: rename a session the requester does not own
- **WHEN** the client sends a rename (REST or WS) for a session owned by a different, non-admin user
- **THEN** the server SHALL reject it with an access error (REST 403)
- **AND** the title SHALL be unchanged

#### Scenario: empty title is rejected
- **WHEN** the client sends a rename with `title: ""` (or whitespace only)
- **THEN** the server SHALL return HTTP 400 with `{ error: "title must be non-empty" }`
- **AND** no change SHALL be made

#### Scenario: title too long is rejected
- **WHEN** the client sends a rename with `title` longer than 200 characters
- **THEN** the server SHALL return HTTP 400 with `{ error: "title must be 200 characters or fewer" }`
- **AND** no change SHALL be made
