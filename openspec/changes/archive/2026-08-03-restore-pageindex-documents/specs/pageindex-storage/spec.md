## ADDED Requirements

### Requirement: Users can upload PDF, Markdown, text, and URL documents
The server SHALL accept document submissions of type PDF, Markdown, plain text, and URL. File uploads SHALL be accepted via multipart upload; text and URL SHALL be accepted via JSON. Each submitted document SHALL be queued for indexing with status `queued`.

#### Scenario: Upload a PDF file
- **WHEN** a client uploads a PDF file to the document add endpoint
- **THEN** the server SHALL queue it for indexing
- **AND** SHALL return the new document id with status `queued`

#### Scenario: Submit a URL
- **WHEN** a client submits a URL for ingestion
- **THEN** the server SHALL fetch the URL (respecting SSRF protection)
- **AND** SHALL queue it for indexing with status `queued`

### Requirement: Users can upload Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV, and HTML documents
The server SHALL accept document submissions of type DOCX, XLSX, PPTX, CSV, and HTML via multipart upload using LlamaIndex readers (`DocxReader`, `XlsReader`, `PptxReader`, `CSVReader`, `HTMLReader`) to extract text. Each file SHALL be queued for indexing with status `queued`.

#### Scenario: Upload a DOCX file
- **WHEN** a client uploads a .docx file to the document add endpoint
- **THEN** the server SHALL extract its text via `DocxReader`
- **AND** SHALL queue it for indexing with status `queued`

#### Scenario: Upload an XLSX file
- **WHEN** a client uploads an .xlsx file to the document add endpoint
- **THEN** the server SHALL extract its text via `XlsReader`
- **AND** SHALL queue it for indexing with status `queued`

#### Scenario: Unsupported file type is rejected
- **WHEN** a client uploads a file with unsupported extension (e.g., .png, .zip)
- **THEN** the server SHALL respond with HTTP 415 and a message naming supported types
- **AND** SHALL NOT create a document record or queue indexing

### Requirement: Document records are persisted to SQLite
Each document's record (id, name, type, status, addedAt, error), extracted source text, and PageIndex index SHALL be persisted to the SQLite project database. Status changes SHALL be written in a single SQLite transaction so a crash mid-write cannot corrupt the registry. On restart, any document left in `queued` or `indexing` status SHALL be marked `error` because its in-memory ingestion payload is gone.

#### Scenario: Status change is transactional
- **WHEN** a document's status changes from `queued` to `indexing` to `ready`
- **THEN** the server SHALL update the document's row in the SQLite database within a single transaction

#### Scenario: Interrupted indexing reconciled on restart
- **WHEN** the server restarts and finds a document in `queued` or `indexing` status
- **THEN** the server SHALL mark that document `error` with a message indicating indexing was interrupted

### Requirement: Users can list and delete documents
The server SHALL expose endpoints to list documents (id, name, type, status, addedAt, error) from SQLite and to delete a document (removing its database record, source text, and PageIndex index). Deletion SHALL be idempotent.

#### Scenario: List documents
- **WHEN** a client calls the document list endpoint
- **THEN** the server SHALL return the current document records from SQLite without index payloads

#### Scenario: Delete a document
- **WHEN** a client deletes a document by id
- **THEN** the server SHALL remove its database record, source text, and index row
- **AND** a subsequent delete of the same id SHALL succeed (idempotent)

### Requirement: Users can query indexed documents
The server SHALL expose a query endpoint that retrieves over all `ready` documents using PageIndex reasoning-based retrieval and returns an answer and the source document names used. If no documents are ready, the server SHALL return an empty answer with no sources.

#### Scenario: Query the collection
- **WHEN** a client posts a query against the document collection
- **THEN** the server SHALL retrieve over all ready documents via PageIndex reasoning
- **AND** SHALL return an answer and the list of source document names used

#### Scenario: No ready documents
- **WHEN** a client posts a query and no documents are `ready`
- **THEN** the server SHALL return an empty answer with no sources

## REMOVED Requirements

### Requirement: WeKnora remote knowledge base integration
**Reason**: Replaced by local PageIndex-based storage to eliminate external infrastructure dependency.

**Migration**: Users migrate to local documents store at `/documents` route instead of remote WeKnora at `/weknora`.
