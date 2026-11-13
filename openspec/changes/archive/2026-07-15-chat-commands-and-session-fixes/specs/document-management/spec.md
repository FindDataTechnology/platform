## ADDED Requirements

### Requirement: Documents added during a session are surfaced in the chat view
The chat UI SHALL show a banner at the top of the chat view listing documents added during the current page session, each with its name and live indexing status, driven by the existing `documents_status` WebSocket events. The banner SHALL be hidden when empty and SHALL cap the number of shown documents to the most recent few. Documents remain a global collection; the banner reflects additions made in the current page session, not a per-chat-session scope.

#### Scenario: a newly added document appears in the chat banner
- **WHEN** the user adds a document (drag-drop, paste, or the Documents panel)
- **THEN** the chat view banner SHALL show the document with status `queued` or `indexing`
- **AND** SHALL update the chip to `ready` or `error` as `documents_status` events arrive

#### Scenario: banner is hidden when no documents have been added
- **WHEN** no documents have been added in the current page session
- **THEN** the chat view banner SHALL be hidden
