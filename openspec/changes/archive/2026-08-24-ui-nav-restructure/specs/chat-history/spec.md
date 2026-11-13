# chat-history delta

## ADDED Requirements

### Requirement: Server exposes a session delete endpoint
The server SHALL expose `DELETE /api/chat-history/sessions/:id` to remove a session by id. The server SHALL delete the on-disk session store file (atomic temp-file + rename, matching the existing write pattern) AND delete the mirror row in the project database (managed by `project-database`). After a successful delete, the server SHALL broadcast a refreshed `sessions` WebSocket event to all connected clients so every open UI sees the updated list. A request for a non-existent id SHALL return 404. A request for the current session id SHALL be rejected with 409 and a clear error (`Cannot delete the active session; switch first`). The dsh runtime's own session persistence (sessions stored by id on disk by dsh itself) SHALL also be removed so reopening the dsh session does not resurrect the deleted entry.

#### Scenario: delete a non-active session
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for a session that is not the current one
- **THEN** the server SHALL remove the on-disk file and the database row
- **AND** broadcast a `sessions` event with the refreshed list
- **AND** return HTTP 200 with `{ ok: true }`

#### Scenario: delete the active session is rejected
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for the current session
- **THEN** the server SHALL return HTTP 409 with `{ error: "Cannot delete the active session; switch first" }`
- **AND** no data SHALL be removed

#### Scenario: delete a non-existent session
- **WHEN** the client sends `DELETE /api/chat-history/sessions/<id>` for an id that does not exist
- **THEN** the server SHALL return HTTP 404 with `{ error: "session not found" }`

#### Scenario: delete broadcasts refreshed list
- **WHEN** a delete completes
- **THEN** every connected WebSocket client SHALL receive a `sessions` event whose `sessions[]` array does not include the deleted id
