## ADDED Requirements

### Requirement: Document module is env-gated and degrades gracefully
The server SHALL initialize the document module at startup using the configured OpenAI-compatible provider (base URL, API key, model id). When the provider configuration is missing, the server SHALL disable document ingestion/query and start normally with chat and other behavior unchanged. The document module SHALL use LlamaIndex.TS as its indexing/retrieval engine, replacing the former PageIndex-based knowledge module.

#### Scenario: provider configured
- **WHEN** the provider base URL, API key, and model are configured at startup
- **THEN** the server SHALL initialize the document module and mount the `/api/documents/*` endpoints
- **AND** SHALL configure LlamaIndex's LLM settings to use the configured provider

#### Scenario: provider missing
- **WHEN** the provider configuration is missing
- **THEN** the server SHALL start without enabling document ingestion
- **AND** SHALL log a notice that the document module is disabled
- **AND** chat and other behavior SHALL remain unchanged

### Requirement: Users can ingest PDF, Markdown, text, and URL documents
The server SHALL accept document submissions of type PDF, Markdown, plain text, and URL. File uploads SHALL be accepted via multipart upload; text and URL SHALL be accepted via JSON. Each submitted document SHALL be queued for indexing. Indexing SHALL run in a serialized queue (one document at a time) with per-document failure isolation: a failure indexing one document SHALL NOT affect others. URL ingestion SHALL block private/local-network hosts (SSRF protection) and SHALL cap fetched content size and duration.

#### Scenario: upload a PDF
- **WHEN** a client uploads a PDF file to the document add endpoint
- **THEN** the server SHALL queue it for indexing using a PDF reader
- **AND** SHALL return the new document id with status `queued`

#### Scenario: submit a URL
- **WHEN** a client submits a URL for ingestion
- **THEN** the server SHALL fetch the URL only after confirming the host is not private or local
- **AND** SHALL cap the fetched content and abort on timeout

#### Scenario: URL points to a private host
- **WHEN** a client submits a URL whose host is loopback, private, link-local, or `.local`
- **THEN** the server SHALL reject it with a clear error and SHALL NOT fetch it

#### Scenario: indexing failure is isolated
- **WHEN** indexing one document fails
- **THEN** that document SHALL be marked `error` with its error message
- **AND** other queued documents SHALL continue to index normally

### Requirement: Document index and manifest are persisted atomically with restart reconciliation
The server SHALL persist each document's index under a per-document storage directory and SHALL maintain a `manifest.json` registry written via temp-file + rename so a crash mid-write cannot corrupt it. On restart, any document left in `queued` or `indexing` status SHALL be marked `error` because its in-memory ingestion payload is gone.

#### Scenario: manifest written atomically
- **WHEN** a document's status changes
- **THEN** the server SHALL write the manifest to a temp file and rename it over the existing manifest

#### Scenario: interrupted indexing reconciled on restart
- **WHEN** the server restarts and finds a document in `queued` or `indexing` status
- **THEN** the server SHALL mark that document `error` with a message indicating indexing was interrupted

### Requirement: Users can list, view, and delete documents
The server SHALL expose endpoints to list documents (id, name, type, status, addedAt, error), to view a document's extracted text/content, and to delete a document (removing its index and manifest entry). Deletion SHALL be idempotent.

#### Scenario: list documents
- **WHEN** a client calls the document list endpoint
- **THEN** the server SHALL return the current document registry without index payloads

#### Scenario: delete a document
- **WHEN** a client deletes a document by id
- **THEN** the server SHALL remove its manifest entry and best-effort delete its stored index
- **AND** a subsequent delete of the same id SHALL succeed (idempotent)

### Requirement: Document status transitions are broadcast as `documents_status` events
The server SHALL broadcast a `documents_status` WebSocket event whenever a document transitions to `queued`, `indexing`, `ready`, or `error`, carrying the document id, name, status, and (on error) the error message. This replaces the former `knowledge_status` event.

#### Scenario: status broadcast on transition
- **WHEN** a document transitions from `indexing` to `ready`
- **THEN** the server SHALL broadcast a `documents_status` event with that document's id, name, and status `ready`

### Requirement: Users can query the document collection
The server SHALL expose a query endpoint that retrieves over all `ready` documents and returns an answer and the source document names used. Retrieval SHALL use a vectorless (reasoning-based) LlamaIndex index so that no embedding model is required.

#### Scenario: query the collection
- **WHEN** a client posts a query against the document collection
- **THEN** the server SHALL retrieve over all ready documents
- **AND** SHALL return an answer and the list of source document names used

#### Scenario: no ready documents
- **WHEN** a client posts a query and no documents are `ready`
- **THEN** the server SHALL return an empty answer with no sources
