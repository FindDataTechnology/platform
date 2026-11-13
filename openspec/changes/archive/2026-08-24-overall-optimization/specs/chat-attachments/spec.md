## ADDED Requirements

### Requirement: Composer provides a file attachment affordance
The web Composer SHALL present a file-attachment affordance (paperclip control) that opens the native browser file picker. Selecting a file SHALL upload it via the existing `POST /api/documents` ingestion endpoint (FormData → multipart parsing → documents RAG store), the same path the Documents panel uses. The upload SHALL reuse the existing ingestion pipeline; no new server-side file store SHALL be introduced. The attachment control SHALL be visible in both desktop and browser contexts (no Electron-only gating).

#### Scenario: user attaches a file to a prompt
- **WHEN** the user clicks the paperclip control and selects a file from the native picker
- **THEN** the file SHALL be uploaded via `POST /api/documents`
- **AND** the Composer SHALL show the attached file as a pending attachment chip until the prompt is sent or the attachment is removed

#### Scenario: attachment upload reuses existing ingestion
- **WHEN** a file is attached and uploaded
- **THEN** the file SHALL be ingested through the same documents RAG pipeline used by the Documents panel
- **AND** no second server-side file store SHALL be created

### Requirement: Attached documents are referenced in the outgoing prompt
The Composer SHALL attach a lightweight reference to each ingested document in the outgoing `prompt` WebSocket message. The server SHALL expand that reference into the agent's context so the model sees the document content for that turn. The reference SHALL NOT inline the file as base64; it SHALL point to the document in the RAG store by id. The expansion SHALL follow the same server-side expansion pattern used for `/skill:` tokens.

#### Scenario: prompt carries a document reference
- **WHEN** the user sends a prompt that has one or more attached documents
- **THEN** the outgoing `prompt` message SHALL carry a reference (e.g. `@doc:<id>`) for each attached document
- **AND** the server SHALL expand the reference into the agent's context before forwarding to the session

#### Scenario: attachment reference is not inlined
- **WHEN** a large file is attached
- **THEN** the prompt SHALL NOT embed the file as base64 in the WebSocket frame
- **AND** the document content SHALL be retrieved from the RAG store at expansion time

#### Scenario: prompt with no attachments is unchanged
- **WHEN** the user sends a prompt with no attached documents
- **THEN** the prompt SHALL be forwarded as today with no document expansion
