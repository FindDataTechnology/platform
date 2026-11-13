## REMOVED Requirements

### Requirement: Document module is env-gated and degrades gracefully
**Reason**: Replaced by WeKnora integration. WeKnora handles all document ingestion, indexing, and retrieval.
**Migration**: Users with existing `documents-store/` data must re-ingest into WeKnora. No automatic migration.

### Requirement: Users can ingest PDF, Markdown, text, and URL documents
**Reason**: Replaced by WeKnora's ingestion pipeline (supports 10+ formats including PDF, Word, Excel, PPT, images).
**Migration**: Use WeKnora's UI at `/weknora` to upload documents.

### Requirement: Document records, source text, and index are persisted to the project database atomically with restart reconciliation
**Reason**: Replaced by WeKnora's PostgreSQL-backed storage.
**Migration**: WeKnora persists data to the shared embedded PostgreSQL. Old `documents-store/` data is not migrated.

### Requirement: Users can list, view, and delete documents
**Reason**: Replaced by WeKnora's document management UI.
**Migration**: Use WeKnora's UI at `/weknora` to manage documents.

### Requirement: Document status transitions are broadcast as `documents_status` events
**Reason**: Replaced by WeKnora's task queue and status tracking.
**Migration**: WeKnora's UI shows indexing status directly. No WebSocket events needed.

### Requirement: Users can query the document collection
**Reason**: Replaced by WeKnora's retrieval and chat features.
**Migration**: Use WeKnora's chat interface at `/weknora` to query knowledge bases.

### Requirement: URL ingestion honors HTTP(S) proxy configuration
**Reason**: Replaced by WeKnora's URL ingestion (proxy config handled by WeKnora).
**Migration**: WeKnora handles URL fetching internally.

### Requirement: Document list status updates are race-free in the UI
**Reason**: Replaced by WeKnora's UI (no longer first-party React).
**Migration**: WeKnora's UI handles status updates.

### Requirement: Documents can be ingested via drag-and-drop and clipboard paste
**Reason**: Replaced by WeKnora's UI (drag-and-drop handled by WeKnora).
**Migration**: WeKnora's UI supports drag-and-drop.

### Requirement: Documents added during a session are surfaced in the chat view
**Reason**: Replaced by WeKnora's chat interface.
**Migration**: WeKnora's chat shows knowledge base context.

### Requirement: Users can ingest DOCX, CSV, HTML, and JSON documents via LlamaIndex readers
**Reason**: Replaced by WeKnora's ingestion pipeline (supports these formats natively).
**Migration**: Use WeKnora's UI to upload these formats.

### Requirement: Unsupported file types are rejected with a clear error
**Reason**: Replaced by WeKnora's ingestion (WeKnora handles format validation).
**Migration**: WeKnora rejects unsupported formats.
