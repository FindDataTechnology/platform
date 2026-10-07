# knowledge-collection Specification

## Purpose
TBD - created by archiving change add-knowledge-collection. Update Purpose after archive.

## Requirements

### Requirement: Multi-type document ingestion

The system SHALL accept knowledge documents of four types: PDF file, Markdown file (`.md`), plain text/notes, and web page provided by URL. Each submitted document SHALL be routed to the appropriate ingestion path based on its type.

#### Scenario: PDF file ingestion

- **WHEN** a user submits a PDF file
- **THEN** the system extracts its content via the `pageindex` library's PDF path and indexes it as a single document

#### Scenario: Markdown file ingestion

- **WHEN** a user submits a Markdown file
- **THEN** the system indexes it via the `pageindex` library's markdown-to-tree path

#### Scenario: Plain text ingestion

- **WHEN** a user submits free-form plain text (no file)
- **THEN** the system treats the text as a Markdown document and indexes it via the markdown-to-tree path

#### Scenario: Web page ingestion via URL

- **WHEN** a user submits a URL
- **THEN** the system fetches the page, converts its HTML to Markdown, and indexes the resulting Markdown

### Requirement: Automatic indexing on add (auto-save)

The system SHALL index every accepted document with the `pageindex` library immediately upon submission. Indexing SHALL begin automatically with no manual "save" action required from the user, and the resulting index SHALL be persisted automatically.

#### Scenario: Document auto-indexed on submission

- **WHEN** a document is submitted
- **THEN** the system queues it for indexing and begins indexing automatically without further user input

#### Scenario: No manual save step

- **WHEN** a user adds a document through any ingestion path
- **THEN** the document is indexed and saved without the user pressing a separate save button

### Requirement: PageIndex-backed indexing with LLM provider reuse

The system SHALL build each document's index using the `pageindex` library configured with the server's existing OpenAI-compatible LLM provider base URL and API key. The system SHALL NOT require a separate OpenAI account or additional credentials beyond those already configured for the chat server.

#### Scenario: Indexing uses the configured provider

- **WHEN** a document is indexed
- **THEN** the `pageindex` library is instantiated with the server's configured provider `baseUrl` and `apiKey` and a supported model id

#### Scenario: Missing provider credentials surface an error

- **WHEN** the configured provider API key is absent or invalid at indexing time
- **THEN** the document is marked as failed with an error and the server continues running

### Requirement: On-disk persistence of the collection

The system SHALL persist each document's `pageindex` result (document name, document description, and the hierarchical tree structure) plus a manifest registry to a dedicated on-disk store. The full collection SHALL be restored from disk when the server restarts.

#### Scenario: Collection survives restart

- **WHEN** the server restarts after documents have been indexed
- **THEN** all previously indexed documents are loaded from disk and appear in the collection with status "ready"

#### Scenario: Manifest updated atomically

- **WHEN** a document finishes indexing or is removed
- **THEN** the manifest registry is updated so a crash mid-write cannot leave the store referencing a missing or partial index

### Requirement: Indexing progress streaming over WebSocket

The system SHALL broadcast indexing status events over the existing WebSocket layer so clients can track each document through the states: `queued`, `indexing`, `ready`, and `error`. Events SHALL include the document id, name, and current status (and an error message when applicable).

#### Scenario: Status broadcast on indexing start

- **WHEN** indexing begins for a document
- **THEN** a WebSocket event with status `indexing` is broadcast to all connected clients

#### Scenario: Status broadcast on completion

- **WHEN** a document finishes indexing successfully

- **THEN** a WebSocket event with status `ready` is broadcast to all connected clients

#### Scenario: Error broadcast on failure

- **WHEN** indexing fails for a document
- **THEN** a WebSocket event with status `error` and the failure message is broadcast, and other documents are unaffected

### Requirement: Collection retrieval by query

The system SHALL accept a natural-language query against the collection and return relevant content drawn from the indexed documents using reasoning-based retrieval over the persisted `pageindex` trees. The response SHALL attribute results to their source document(s). Per-document retrieval work (node selection and per-document answering) SHALL execute with bounded concurrency rather than strictly sequentially, and retrieval SHALL NOT load document `source_text` content it does not use; parsed index trees SHALL be cached in memory and invalidated when a document is re-indexed. Per-document failure isolation SHALL be preserved under parallel execution.

#### Scenario: Query returns relevant content with source

- **WHEN** a user queries the collection and matching content exists
- **THEN** the system returns an answer/excerpt and the name(s) of the source document(s)

#### Scenario: Query against empty collection

- **WHEN** a user queries the collection and no documents have been indexed
- **THEN** the system returns an empty result without error

#### Scenario: Multi-document query runs with bounded concurrency

- **WHEN** a query runs against a collection with several ready documents
- **THEN** at most a configured number of documents (default 3) are processed concurrently, with remaining documents queued
- **AND** one document's retrieval failure SHALL NOT abort the others

#### Scenario: Repeated queries reuse parsed index trees

- **WHEN** the same documents are queried again without modification
- **THEN** their serialized index trees SHALL be served from the in-memory cache without re-parsing from the database

### Requirement: Collection listing and removal

The system SHALL support listing all documents in the collection (each with id, name, type, status, and added date) and removing a document by id. Removal SHALL delete the document's persisted index and remove its entry from the manifest.

#### Scenario: List the collection

- **WHEN** a client requests the collection list
- **THEN** the system returns all documents with their metadata and current status

#### Scenario: Remove a document

- **WHEN** a client requests removal of a document by id
- **THEN** the system deletes the document's persisted index, removes its manifest entry, and it no longer appears in the collection

### Requirement: Per-document failure isolation

The system SHALL isolate indexing failures to the offending document. A failure (unreadable PDF, unreachable URL, LLM error) SHALL mark only that document as `error` and SHALL NOT crash the server or block indexing of other documents.

#### Scenario: One failed document does not block others

- **WHEN** document A fails to index while documents B and C are queued
- **THEN** document A is marked `error` and documents B and C continue indexing normally
