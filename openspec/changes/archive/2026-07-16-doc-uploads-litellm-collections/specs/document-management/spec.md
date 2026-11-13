## ADDED Requirements

### Requirement: Users can ingest DOCX, CSV, HTML, and JSON documents via LlamaIndex readers
The server SHALL accept document submissions of type DOCX (`.docx`), CSV (`.csv`), HTML (`.html`/`.htm`), and JSON (`.json`) via multipart upload, in addition to PDF, Markdown, text, and URL. Each new type SHALL be parsed by the corresponding `@llamaindex/readers` reader (`DocxReader`, `CSVReader`, `HTMLReader`, `JSONReader`) to extract text, which SHALL then be indexed through PageIndex and persisted to the project database using the same pipeline (serialized queue, per-document failure isolation, transactional status writes) as the existing types. A failure to extract text from a supported type SHALL mark that document `error` without affecting others. (PPTX is not supported because `@llamaindex/readers` ships no PPTX reader.)

#### Scenario: upload a DOCX
- **WHEN** a client uploads a `.docx` file to the document add endpoint
- **THEN** the server SHALL extract its text via a LlamaIndex DOCX reader
- **AND** SHALL queue it for indexing and return the new document id with status `queued`

#### Scenario: upload a CSV
- **WHEN** a client uploads a `.csv` file to the document add endpoint
- **THEN** the server SHALL extract its text via a LlamaIndex CSV reader
- **AND** SHALL queue it for indexing and return the new document id with status `queued`

#### Scenario: upload an HTML file
- **WHEN** a client uploads a `.html` or `.htm` file to the document add endpoint
- **THEN** the server SHALL extract its text via a LlamaIndex HTML reader
- **AND** SHALL queue it for indexing and return the new document id with status `queued`

#### Scenario: extraction failure is isolated
- **WHEN** text extraction fails for one supported document
- **THEN** that document SHALL be marked `error` with its error message
- **AND** other queued documents SHALL continue to index normally

### Requirement: Unsupported file types are rejected with a clear error
The server SHALL reject multipart uploads whose file extension is not one of the supported types (`.pdf`, `.md`, `.markdown`, `.docx`, `.csv`, `.html`, `.htm`, `.json`) with an HTTP 415 response and a clear error message, and SHALL NOT classify an unsupported file as Markdown or attempt to decode its bytes as text.

#### Scenario: unsupported extension is rejected
- **WHEN** a client uploads a file with an unsupported extension (for example `.png` or `.zip`)
- **THEN** the server SHALL respond with HTTP 415 and a message naming the supported types
- **AND** SHALL NOT create a document record or queue indexing

#### Scenario: drag-dropped unsupported file is rejected
- **WHEN** the UI submits an unsupported file via the drag-and-drop or paste path
- **THEN** the server SHALL respond with HTTP 415
- **AND** the UI SHALL surface a notice to the user

## MODIFIED Requirements

### Requirement: Documents can be ingested via drag-and-drop and clipboard paste
The web UI SHALL accept document ingestion via site-wide drag-and-drop of files and clipboard paste, in addition to the Documents-tab forms. Dropped and pasted files SHALL be mapped by extension to a supported type (PDF, Markdown, DOCX, CSV, HTML, or JSON) and submitted through the existing document ingestion endpoint; files whose extension is not supported SHALL be rejected by the server (HTTP 415) and surfaced as a notice rather than silently classified. Pasted files SHALL be ingested as files; pasted plain text or URLs SHALL be ingested as text or URL respectively, but only when the paste target is not a text-editable element (`input`, `textarea`, or `[contenteditable]`) so normal text entry is not interrupted. Ingestion SHALL reuse the existing pipeline (serialized queue, SSRF protection, size and duration caps) and live status SHALL be surfaced through existing `documents_status` events plus a transient UI notice. When the document module is disabled, drag/paste SHALL show a notice and SHALL NOT call the ingestion endpoint.

#### Scenario: dropping a supported file ingests it
- **WHEN** the user drops a supported file (for example a PDF or DOCX) onto the page
- **THEN** the UI SHALL submit the file to the document ingestion endpoint
- **AND** a `documents_status` event SHALL eventually transition the document to `ready`

#### Scenario: dropping an unsupported file is rejected
- **WHEN** the user drops a file with an unsupported extension onto the page
- **THEN** the UI SHALL submit it and the server SHALL respond with HTTP 415
- **AND** the UI SHALL show a notice that the file type is not supported

#### Scenario: pasting text outside an editable field ingests it
- **WHEN** the user pastes plain text while not focused in an `input`, `textarea`, or `[contenteditable]` element
- **THEN** the UI SHALL ingest the pasted text as a text document
