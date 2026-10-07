# chat-history Specification

## Purpose
Chat sessions as durable, user-facing history: every conversation is mirrored to the project database as it runs, and users can list, start, resume, switch, rename, and delete sessions — the list refreshes after each turn ends, and each session records the workspace it ran in.

## Requirements
### Requirement: Chat sessions are mirrored to the project database as the conversation progresses
The server SHALL mirror each chat session's user prompts and assistant responses into the project SQLite database (managed by `project-database`) as the conversation progresses - the user message on `prompt` and the assistant's final message on turn completion (`done`). This SHALL apply to **both local dsh agent turns and remote (catalog `agent-remote`) agent turns**: remote turns (streamed via `streamRemoteChat`) SHALL be persisted on stream completion via the same `recordMessage()` path as local turns, so a browser close/reopen does not leave a dangling user message with no reply. The project database SHALL be the store of record for the session list and read-only view APIs. The dsh runtime persists sessions by id to its own disk store; the server SHALL keep the SQLite mirror in sync as turns progress. The server SHALL track a current session in memory. Each session SHALL expose an id, a title (derived from the first user message), creation timestamp, and update timestamp. SQLite writes SHALL be atomic and crash-safe via transactions.

Before persisting assistant text, the server SHALL normalize **functional references** only: a markdown link whose target is a `data:text/*` URI SHALL be replaced by a workspace file link when the decoded payload's bytes match a file under the session workspace, and SHALL be reduced to its link text otherwise; a markdown link whose absolute-path target resolves under the session workspace SHALL be rewritten to workspace-relative form. Narrative content — prose and inline code spans — SHALL NOT be altered by normalization.

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

#### Scenario: data URI link matching a workspace file becomes a platform link
- **WHEN** an assistant message contains a markdown link whose target is a `data:text/*` URI, and the decoded payload's bytes match a file under the session workspace
- **THEN** the mirrored message stores the link with a workspace-relative path to that file instead of the `data:` URI

#### Scenario: data URI link without a match is reduced to plain text
- **WHEN** an assistant message contains a markdown link whose target is a `data:text/*` URI and no workspace file matches its payload
- **THEN** the mirrored message stores the link's visible text without the `data:` URI target

#### Scenario: absolute in-workspace link is rewritten relative
- **WHEN** an assistant message contains a markdown link whose absolute-path target resolves under the session workspace
- **THEN** the mirrored message stores that link with a workspace-relative target

#### Scenario: narrative content is untouched
- **WHEN** an assistant message contains absolute paths or `data:` URIs inside prose or inline code spans rather than markdown link targets
- **THEN** the mirrored message stores them verbatim

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

### Requirement: Session list refreshes after every turn end
The server SHALL broadcast a refreshed session list whenever an agent turn ends, whether the turn succeeded or failed, so that a newly created session appears in the sidebar even when its first turn errors. The list SHALL also be broadcast when a client connects and when a session is created or switched.

#### Scenario: session list refreshes after a failed turn
- **WHEN** an agent turn ends with an error
- **THEN** the server SHALL broadcast a refreshed session list
- **AND** any session created during that turn SHALL appear in the list

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


### Requirement: Sessions record their owner
The session mirror SHALL stamp the authenticated owner (see `session-ownership`) on a session when its first turn is mirrored and SHALL NOT change it afterwards. The underlying storage change SHALL be an additive migration; sessions created before this capability are assigned to the deploy-designated owner account by that migration.

#### Scenario: first turn stamps the owner
- **WHEN** a new session's first user turn is mirrored from `alice@example.com`'s connection
- **THEN** the session record carries `alice@example.com` as its owner

#### Scenario: pre-existing sessions are assigned
- **WHEN** the additive migration runs
- **THEN** every pre-existing session row carries the deploy-designated owner

### Requirement: Sessions record the workspace they ran in
The session mirror SHALL stamp the runtime workspace on a session when its
first turn is mirrored and SHALL NOT change it afterwards, including when the
runtime workspace is switched mid-conversation. The sessions list payload and
the `sessions` WebSocket broadcast SHALL include the recorded workspace
(absent for sessions created before this capability). The underlying storage
change SHALL be an additive migration.

#### Scenario: first turn stamps the workspace
- **WHEN** a new session's first user turn is mirrored while the runtime
  workspace is `/home/me/paas`
- **THEN** the session record carries `/home/me/paas` and the sessions
  broadcast includes it

#### Scenario: workspace switch mid-session does not re-stamp
- **WHEN** the user switches the runtime workspace and continues the same
  session
- **THEN** the session's recorded workspace is unchanged

#### Scenario: pre-existing sessions have no workspace
- **WHEN** the sessions payload includes rows created before this capability
- **THEN** those rows carry no workspace value and clients render them under
  the Ungrouped group
