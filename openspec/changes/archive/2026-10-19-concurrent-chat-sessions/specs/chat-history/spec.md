## REMOVED Requirements

### Requirement: Users can switch the active chat session
**Reason**: The requirement's core clause ("Switching SHALL be rejected while the agent is streaming") and its scenario "switch rejected while streaming" describe behavior the product no longer has — switching is always allowed and never disturbs an in-flight turn (concurrent-chat-sessions). The clause had already drifted from the code (which cancelled rather than rejected); the replacement below states the new contract in full rather than inverting a scenario in place.
**Migration**: Replaced by "Users can switch the active chat session without disturbing in-flight turns" in this same capability. No client change is needed to keep switching; clients that relied on a switch being rejected (or implicitly aborting a turn) must send `stop_turn` explicitly.

## ADDED Requirements

### Requirement: Users can switch the active chat session without disturbing in-flight turns
The server SHALL accept a `switch_session` WebSocket message and point the live agent at the requested session by id, delivering a `session_loaded` event carrying the session id, title, and message list to the requesting connection and any other connection viewing that session (per-viewer delivery, `session-ownership`). Switching SHALL be allowed while any session — including the one being left — is streaming, and SHALL NOT cancel, pause or otherwise affect any in-flight turn; the outgoing session's turn continues, and its events keep flowing to its remaining viewers and into its replay log (`web-chat-server`). The request SHALL be rejected with an access error when the requester neither owns the session nor is an admin-group user. The active session SHALL be reflected as highlighted in the sidebar.

#### Scenario: switch to a session
- **WHEN** a client sends `switch_session` for a valid session id it owns
- **THEN** the server SHALL point the live agent at that session
- **AND** SHALL deliver `session_loaded` with that session's id, title, and messages to the requesting connection and same-session viewers

#### Scenario: switching away from a streaming session leaves it running
- **WHEN** session A is streaming and the viewing client sends `switch_session` for session B
- **THEN** the server SHALL complete the switch and deliver `session_loaded` for B
- **AND** A's turn SHALL continue to completion with no cancel issued
- **AND** a later `switch_session` back to A SHALL answer with `running: true` and the replay log while A is still in flight

#### Scenario: another connection's navigation does not disturb a streaming session
- **WHEN** connection 1 views streaming session A and connection 2 sends `switch_session` for session B
- **THEN** A's turn SHALL continue and connection 1 SHALL keep receiving A's events

#### Scenario: switch to an unknown session
- **WHEN** a client sends `switch_session` for an id that does not exist
- **THEN** the server SHALL send an error and the active session SHALL remain unchanged

#### Scenario: switch to a session the requester does not own
- **WHEN** a client sends `switch_session` for a session owned by a different, non-admin user
- **THEN** the server SHALL send an access error and the active session SHALL remain unchanged

## MODIFIED Requirements

### Requirement: Server exposes a session delete endpoint
The server SHALL expose `DELETE /api/chat-history/sessions/:id` to remove a session by id. The server SHALL delete the on-disk session store file (atomic temp-file + rename, matching the existing write pattern) AND delete the mirror row in the project database (managed by `project-database`). After a successful delete, the server SHALL deliver a refreshed `sessions` WebSocket event to every connected client, each computed from that client's user visibility. A request for a non-existent id SHALL return 404. A request for the current session id, OR for a session whose turn is in flight, OR for a session with a queued prompt (`turn-dispatch`), SHALL be rejected with 409 and a clear error (`Cannot delete the active session; switch first`). A request for a session the requester neither owns nor is admin for SHALL be rejected with 403 and remove nothing. The dsh runtime's own session persistence (sessions stored by id on disk by dsh itself) SHALL also be removed so reopening the dsh session does not resurrect the deleted entry.

#### Scenario: delete a non-active session
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for a session it owns that is not the current one and has no in-flight or queued turn
- **THEN** the server SHALL remove the on-disk file and the database row
- **AND** deliver a `sessions` event with the refreshed list to every client (each scoped to its user)
- **AND** return HTTP 200 with `{ ok: true }`

#### Scenario: delete the active session is rejected
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for the current session
- **THEN** the server SHALL return HTTP 409 with `{ error: "Cannot delete the active session; switch first" }`
- **AND** no data SHALL be removed

#### Scenario: delete a background-streaming session is rejected
- **WHEN** the client views session B and sends `DELETE /api/chat-history/sessions/<id>` for session A whose turn is in flight
- **THEN** the server SHALL return HTTP 409 and no data SHALL be removed

#### Scenario: delete a queued session is rejected
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for a session with a queued prompt
- **THEN** the server SHALL return HTTP 409 and no data SHALL be removed

#### Scenario: delete a non-existent session
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for an id that does not exist
- **THEN** the server SHALL return HTTP 404 with `{ error: "session not found" }`

#### Scenario: delete a session the requester does not own
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for a session owned by a different, non-admin user
- **THEN** the server SHALL return HTTP 403 and no data SHALL be removed

#### Scenario: delete broadcasts refreshed list
- **WHEN** a delete completes
- **THEN** every connected WebSocket client SHALL receive a `sessions` event whose `sessions[]` array does not include the deleted id and matches that client's user visibility
