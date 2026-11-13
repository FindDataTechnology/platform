## Purpose

Chat sessions are private to the account that created them: every session records an owner, session-scoped reads and mutations are gated by that ownership, and conversation events reach only the clients entitled to see them. This is the single-process deployment's privacy stopgap on the road to the per-user-cell end state — it closes cross-account history access without changing the shared-runtime topology.

## ADDED Requirements

### Requirement: Each session records its owner

Every chat session SHALL record the identity (email) of the authenticated user whose connection submitted the session's first user message, stamped once and never re-stamped. Mini-program token identities resolve to their bound email and are full owners. Sessions that pre-date this capability SHALL be assigned in a one-time additive migration to a single administrator-designated owner account, chosen at deploy time.

#### Scenario: first message stamps the owner

- **WHEN** a session's first user message is mirrored and the submitting connection is authenticated as `alice@example.com`
- **THEN** the session record carries `alice@example.com` as its owner
- **AND** later turns from other connections SHALL NOT change it

#### Scenario: mini-program user owns their sessions

- **WHEN** a session's first user message arrives over a connection authenticated by a mini-program bind-code token bound to `wx_user@mp`
- **THEN** the session's owner is `wx_user@mp`

#### Scenario: legacy sessions are assigned at migration

- **WHEN** the migration runs on a database with sessions created before this capability
- **THEN** every such session is assigned to the deploy-designated owner account
- **AND** no session is left without an owner

### Requirement: Session visibility is scoped by requester

The session list — the `sessions` WebSocket event and the REST list — SHALL include only sessions owned by the requesting connection's authenticated user. Admin-group users SHALL receive all sessions. Each connected client SHALL be able to depend on its list containing no session owned by a different, non-admin user.

#### Scenario: two users see disjoint lists

- **WHEN** `alice@example.com` and `bob@example.com` each own sessions and both request the list
- **THEN** each list contains only that user's own sessions

#### Scenario: admin sees all sessions

- **WHEN** a user in the admin group requests the list
- **THEN** the list contains sessions of every owner

### Requirement: Session-scoped operations are ownership-gated

Switching into a session, reading a session's messages, renaming a session, and deleting a session SHALL be rejected with an access error when the requester is neither the session's owner nor an admin-group user. The rejection SHALL use the deployment's existing error shapes (WS `error` message; REST 403) and SHALL NOT include any of the session's content. Public share tokens issued under `session-share` are the one deliberate cross-owner door and are exempt (they remain read-only and token-gated).

#### Scenario: switching into a foreign session is rejected

- **WHEN** `bob@example.com` sends `switch_session` for a session owned by `alice@example.com`
- **THEN** the server rejects the request with an access error
- **AND** the live agent's active session is unchanged

#### Scenario: reading a foreign session over REST is rejected

- **WHEN** `bob@example.com` requests the session's messages over REST
- **THEN** the server responds HTTP 403 without message content

#### Scenario: deleting a foreign session is rejected

- **WHEN** `bob@example.com` sends the delete request for a session owned by `alice@example.com`
- **THEN** the server responds HTTP 403 and no data is removed

#### Scenario: renaming a foreign session is rejected

- **WHEN** `bob@example.com` sends a rename (REST or WS) for a session owned by `alice@example.com`
- **THEN** the server rejects the rename and the title is unchanged

### Requirement: A user's turn attributes to the session that user is viewing

The server SHALL track, per connection, the session that connection's client is viewing. A prompt received from a connection SHALL be recorded into that connection's viewed session. The shared runtime still executes one turn at a time — this requirement fixes attribution, not concurrency.

#### Scenario: two users in different sessions

- **WHEN** `alice@example.com` is viewing session A and `bob@example.com` is viewing session B, and bob sends a prompt
- **THEN** the user message and the assistant's reply are recorded into session B
- **AND** session A's transcript is unchanged

### Requirement: Conversation events are delivered per-viewer

Turn events (`agent_start`, text deltas, tool events, `done`, `error`), `session_loaded`, and session-scoped refreshes SHALL be delivered only to the connections whose viewed session is the session the event belongs to. The `sessions` list event SHALL be computed per connection from that connection's user visibility. Turn events SHALL carry the id of the session they belong to.

#### Scenario: a streaming turn is not delivered to a foreign viewer

- **WHEN** a turn streams in session A while `bob@example.com`'s client is viewing session B
- **THEN** bob's client receives none of that turn's delta or tool events

#### Scenario: session_loaded reaches the requester, not everyone

- **WHEN** a client sends `switch_session` and the load completes
- **THEN** `session_loaded` is delivered to that client (and any other connection viewing the same session)
- **AND** clients viewing other sessions do not receive it

#### Scenario: each client's sessions event matches its own visibility

- **WHEN** a turn ends and session lists refresh
- **THEN** every connected client receives a `sessions` event containing only its user's visible sessions
