# chat-attachments Specification

## Purpose
TBD - created by syncing change overall-optimization. Update Purpose after archive.

## Requirements

### Requirement: Composer provides a file attachment affordance
The web Composer SHALL present a file-attachment affordance (paperclip control) that opens the native browser file picker. Selecting a file SHALL upload it via the existing `POST /api/documents` ingestion endpoint (FormData → multipart parsing → documents RAG store), the same path the Documents panel uses. The upload SHALL reuse the existing ingestion pipeline. In addition to ingestion, the server SHALL persist the file's original bytes in the preview `uploads/` root and SHALL return a preview reference for the stored file in the upload response, so the attachment can be displayed in the preview drawer. Persisting the original SHALL NOT alter what is indexed for the agent or what the prompt references. The attachment control SHALL be visible in both desktop and browser contexts (no Electron-only gating).

#### Scenario: user attaches a file to a prompt
- **WHEN** the user clicks the paperclip control and selects a file from the native picker
- **THEN** the file SHALL be uploaded via `POST /api/documents`
- **AND** the Composer SHALL show the attached file as a pending attachment chip until the prompt is sent or the attachment is removed

#### Scenario: attachment upload reuses existing ingestion
- **WHEN** a file is attached and uploaded
- **THEN** the file SHALL be ingested through the same documents RAG pipeline used by the Documents panel
- **AND** the file's original bytes SHALL additionally be persisted in the preview `uploads/` root

#### Scenario: upload response carries a preview reference
- **WHEN** a file attachment upload succeeds
- **THEN** the response SHALL include a preview reference for the stored original
- **AND** the reference SHALL resolve against the preview file route

#### Scenario: attachment chip opens the preview
- **WHEN** an attachment chip is in the attached state
- **THEN** activating it SHALL open the stored original in the preview drawer
- **AND** opening the preview SHALL NOT send the file's bytes to the agent or alter the outgoing prompt

#### Scenario: ingestion failure still stores the original
- **WHEN** a file is attached whose text extraction fails
- **THEN** the chip SHALL still report the failure as it does today
- **AND** the file's original SHALL still be stored and previewable from the chip
- **AND** the prompt reference behavior SHALL be unchanged

### Requirement: A stored attachment original is removed with its document

The server SHALL persist each attachment's original bytes at a location derived from its document id, and SHALL remove the stored original when that document is removed, so that deleting a document does not leave orphaned bytes in the preview root.

#### Scenario: deleting a document removes its stored original
- **WHEN** a document that was created from an attachment is deleted
- **THEN** the stored original for that document SHALL be removed from the preview root
- **AND** a subsequent request for that file SHALL return not-found

#### Scenario: deletion is idempotent
- **WHEN** a document is deleted whose stored original is already absent
- **THEN** the deletion SHALL succeed without error

### Requirement: Attached documents are referenced in the outgoing prompt

The Composer SHALL attach a lightweight reference to each ingested document in the outgoing `prompt` WebSocket message. Server-side expansion SHALL inject, per referenced document, a bounded light context — document name, a short summary, and a pointer instructing the agent to use the library tools (`list_library` / `search_library` / `read_document`) for full content — instead of a source-text prefix. The reference SHALL NOT inline the file as base64; it SHALL point to the document in the library by id. The user-visible message SHALL keep the raw `@doc:<id>` references. A referenced document without available content SHALL expand to an explicit unavailability note.

#### Scenario: prompt carries a document reference

- **WHEN** the user sends a prompt that has one or more attached documents
- **THEN** the outgoing `prompt` message SHALL carry a reference (e.g. `@doc:<id>`) for each attached document
- **AND** the server SHALL expand the reference into light context (name, summary, tool pointers) before forwarding to the session

#### Scenario: attachment reference is not inlined

- **WHEN** a large file is attached
- **THEN** the prompt SHALL NOT embed the file as base64 in the WebSocket frame
- **AND** the expansion SHALL NOT inject the document's full source text; the agent retrieves full content on demand via the library tools

#### Scenario: prompt with no attachments is unchanged

- **WHEN** the user sends a prompt with no attached documents
- **THEN** the prompt SHALL be forwarded as today with no document expansion

#### Scenario: single-file attachment expansion

- **WHEN** a prompt carrying `@doc:<id>` for a ready document is sent
- **THEN** the agent-visible prompt contains the document's name, summary, and tool guidance, and does not contain the document's full source text

#### Scenario: collection hint injection

- **WHEN** a conversation is started from a collection
- **THEN** the initial context names the collection and its member documents and directs the agent to retrieve specifics with the library tools, without injecting member source text

#### Scenario: unavailable document

- **WHEN** a prompt references a document id with no retrievable content
- **THEN** the expansion states the document is unavailable so the agent can tell the user
