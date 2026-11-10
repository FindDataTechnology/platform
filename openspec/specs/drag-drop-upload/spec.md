# drag-drop-upload Specification

## Purpose
Defines the drag-and-drop file upload capability in the chat Composer component for quick document ingestion.

## Requirements

### Requirement: Users can drag-and-drop files onto the chat input
The Composer component SHALL accept file drops from the operating system file picker or folder browsers, attaching each dropped file through the SAME path as the paperclip — one multipart `POST /api/documents` per file, with no client-side type pre-filter. The server SHALL classify the uploaded file and attempt extraction; when extraction fails (an unsupported or unreadable type) it SHALL respond with HTTP 422 carrying the failure `error` and the stored original's `preview` reference, and the Composer SHALL keep the attachment chip in its failed state showing the reason and surface a failure toast. Pasted text SHALL NOT be ingested as a document: pasting into the Composer edits the message body through the editor's native paste behaviour, and the platform SHALL NOT intercept it to create a document.

#### Scenario: Drop PDF onto chat
- **WHEN** user drops a .pdf file onto the Composer textarea
- **THEN** the system SHALL upload it via `/api/documents` with `multipart/form-data` encoding
- **AND** the attachment chip SHALL flip from uploading to attached with the extracted document id

#### Scenario: Paste text into non-editable context
- **WHEN** user pastes plain text at composer focus point
- **THEN** the text SHALL enter the message body as normal editing input
- **AND** no document SHALL be created by the paste
- **AND** normal text editing in input fields SHALL NOT be interrupted

#### Scenario: Drop unsupported file type
- **WHEN** user drops an image file (.png, .jpg) onto Composer
- **THEN** the server SHALL answer the upload with HTTP 422 carrying the extraction failure and the stored original's reference
- **AND** the attachment chip SHALL show the failed state with the reason, plus a failure toast
