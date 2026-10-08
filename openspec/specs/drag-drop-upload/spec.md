# drag-drop-upload Specification

## Purpose
Defines the drag-and-drop file upload capability in the chat Composer component for quick document ingestion.

## Requirements

### Requirement: Users can drag-and-drop files onto the chat input
The Composer component SHALL accept file drops from the operating system file picker or folder browsers. When a file is dropped:
- The extension SHALL be detected and mapped to a supported document type
- If supported, the file SHALL be submitted to `/api/documents` via multipart upload
- If unsupported, the server SHALL respond with HTTP 415 and the UI SHALL show a notice
- Pasted plain text OR URLs SHALL be ingested as text documents only when pasted outside editable elements (input, textarea, contenteditable)

#### Scenario: Drop PDF onto chat
- **WHEN** user drops a .pdf file onto the Composer textarea
- **THEN** the system SHALL detect `.pdf` extension and classify as "pdf" type
- **AND** SHALL submit via `/api/documents` with `multipart/form-data` encoding

#### Scenario: Paste text into non-editable context
- **WHEN** user pastes plain text at composer focus point
- **THEN** the system SHALL ingest as text document type
- **AND** SHALL NOT interrupt normal text editing in input fields

#### Scenario: Drop unsupported file type
- **WHEN** user drops an image file (.png, .jpg) onto Composer
- **THEN** the system SHALL reject via server with HTTP 415
- **AND** SHALL show user-friendly notice about unsupported types
