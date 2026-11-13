## ADDED Requirements

### Requirement: Documents can be ingested via drag-and-drop and clipboard paste
The web UI SHALL accept document ingestion via site-wide drag-and-drop of files and clipboard paste, in addition to the Documents-tab forms. Dropped files SHALL be mapped by extension to PDF, Markdown, or text and submitted through the existing document ingestion endpoint. Pasted files SHALL be ingested as files; pasted plain text or URLs SHALL be ingested as text or URL respectively, but only when the paste target is not a text-editable element (`input`, `textarea`, or `[contenteditable]`) so normal text entry is not interrupted. Ingestion SHALL reuse the existing pipeline (serialized queue, SSRF protection, size and duration caps) and live status SHALL be surfaced through existing `documents_status` events plus a transient UI notice. When the document module is disabled, drag/paste SHALL show a notice and SHALL NOT call the ingestion endpoint.

#### Scenario: dropping a file ingests it
- **WHEN** the user drops a PDF file onto the page
- **THEN** the UI SHALL submit the file to the document ingestion endpoint
- **AND** a `documents_status` event SHALL eventually transition the document to `ready`

#### Scenario: pasting text outside an editable field ingests it
- **WHEN** the user pastes plain text while not focused in an `input`, `textarea`, or `[contenteditable]` element
- **THEN** the UI SHALL ingest the pasted text as a text document

#### Scenario: pasting into the chat input is not hijacked
- **WHEN** the user pastes text into the chat input
- **THEN** the text SHALL be entered into the input normally
- **AND** no document SHALL be ingested

#### Scenario: drag and paste are disabled when the document module is off
- **WHEN** the document module is disabled and the user drops a file onto the page
- **THEN** the UI SHALL show a notice that the document collection is disabled
- **AND** SHALL NOT call the ingestion endpoint
