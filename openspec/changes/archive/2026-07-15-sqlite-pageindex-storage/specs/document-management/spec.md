## MODIFIED Requirements

### Requirement: Document module is env-gated and degrades gracefully
The server SHALL initialize the document module at startup using the configured OpenAI-compatible provider (base URL, API key, model id) AND a ready project SQLite database. When either the provider configuration or the project database is unavailable, the server SHALL disable document ingestion/query and start normally with chat and other behavior unchanged. The document module SHALL use LlamaIndex.TS as its data-management framework, with PageIndex as the indexing layer accessed through LlamaIndex; LlamaIndex SHALL save document data into PageIndex and SHALL read structured data (source text, index data) from the project database.

#### Scenario: provider and database configured
- **WHEN** the provider base URL, API key, and model are configured at startup AND the project database is ready
- **THEN** the server SHALL initialize the document module and mount the `/api/documents/*` endpoints
- **AND** SHALL configure LlamaIndex's LLM settings to use the configured provider
- **AND** SHALL index documents through PageIndex accessed via LlamaIndex

#### Scenario: provider or database missing
- **WHEN** the provider configuration is missing OR the project database is unavailable
- **THEN** the server SHALL start without enabling document ingestion
- **AND** SHALL log a notice that the document module is disabled
- **AND** chat and other behavior SHALL remain unchanged

### Requirement: Document records, source text, and index are persisted to the project database atomically with restart reconciliation
The server SHALL persist each document's record (id, name, type, status, addedAt, error), extracted source text, and PageIndex index in the project SQLite database rather than per-document storage directories or a `manifest.json` file. Status changes SHALL be written in a single SQLite transaction so a crash mid-write cannot corrupt the registry. On restart, any document left in `queued` or `indexing` status SHALL be marked `error` because its in-memory ingestion payload is gone.

#### Scenario: status change is transactional
- **WHEN** a document's status changes
- **THEN** the server SHALL update the document's row in the project database within a single transaction

#### Scenario: interrupted indexing reconciled on restart
- **WHEN** the server restarts and finds a document in `queued` or `indexing` status
- **THEN** the server SHALL mark that document `error` with a message indicating indexing was interrupted

### Requirement: Users can list, view, and delete documents
The server SHALL expose endpoints to list documents (id, name, type, status, addedAt, error) from the project database, to view a document's extracted source text, and to delete a document (removing its database record, source text, and index row). Deletion SHALL be idempotent.

#### Scenario: list documents
- **WHEN** a client calls the document list endpoint
- **THEN** the server SHALL return the current document records from the project database without index payloads

#### Scenario: delete a document
- **WHEN** a client deletes a document by id
- **THEN** the server SHALL remove its database record, source text, and index row
- **AND** a subsequent delete of the same id SHALL succeed (idempotent)

### Requirement: Users can query the document collection
The server SHALL expose a query endpoint that retrieves over all `ready` documents and returns an answer and the source document names used. Retrieval SHALL use PageIndex as a vectorless (reasoning-based) index accessed through LlamaIndex.TS, so that no embedding model is required; LlamaIndex SHALL read document source text and index data from the project database.

#### Scenario: query the collection
- **WHEN** a client posts a query against the document collection
- **THEN** the server SHALL retrieve over all ready documents via PageIndex through LlamaIndex
- **AND** SHALL return an answer and the list of source document names used

#### Scenario: no ready documents
- **WHEN** a client posts a query and no documents are `ready`
- **THEN** the server SHALL return an empty answer with no sources
