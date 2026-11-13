# chat-attachments Specification

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: A stored attachment original is removed with its document

The server SHALL persist each attachment's original bytes at a location derived from its document id, and SHALL remove the stored original when that document is removed, so that deleting a document does not leave orphaned bytes in the preview root.

#### Scenario: deleting a document removes its stored original
- **WHEN** a document that was created from an attachment is deleted
- **THEN** the stored original for that document SHALL be removed from the preview root
- **AND** a subsequent request for that file SHALL return not-found

#### Scenario: deletion is idempotent
- **WHEN** a document is deleted whose stored original is already absent
- **THEN** the deletion SHALL succeed without error
