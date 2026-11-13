## ADDED Requirements

### Requirement: Users can view the Documents panel at /documents route
The web application SHALL expose a `/documents` route that renders the React Documents page, accessible from the sidebar navigation with a "Documents" link. The page SHALL show the list of indexed documents, upload form, status tracking, and query interface.

#### Scenario: Navigate to Documents panel
- **WHEN** user clicks "Documents" in sidebar
- **THEN** the application SHALL navigate to `/documents` route
- **AND** SHALL render the Documents page component

#### Scenario: Page loads document list
- **WHEN** user opens `/documents` route
- **THEN** the page SHALL fetch current document list via `/api/documents` endpoint
- **AND** SHALL display each document with id, name, type, status, and addedAt

### Requirement: Users can upload documents via drag-drop or file picker
The Documents page SHALL accept uploads via (a) clicking the upload button/file picker, and (b) drag-and-drop files onto the chat input in any page. Files SHALL be auto-detected by extension and validated against supported types.

#### Scenario: Drag-drop a PDF to chat input
- **WHEN** user drags a PDF file onto the Composer textarea
- **THEN** the system SHALL submit it to `/api/documents` endpoint
- **AND** SHALL show a toast notification confirming upload received

#### Scenario: File picker upload
- **WHEN** user clicks upload button and selects multiple files
- **THEN** the system SHALL submit each file sequentially
- **AND** SHALL queue each for indexing showing `queued` status

### Requirement: Document status is tracked via WebSocket events
Each document's status transitions (`queued` → `indexing` → `ready` or `error`) SHALL be broadcast as `documents_status` WebSocket events. The UI SHALL update per-document rows in real-time without polling.

#### Scenario: Status updates live in UI
- **WHEN** a document finishes indexing
- **THEN** server SHALL emit `documents_status` event with `ready` status
- **AND** the UI SHALL update that row's status badge to green "Ready"

### Requirement: Users can query indexed documents
The Documents page SHALL provide a query input box that posts to `/api/documents/query` endpoint, showing an answer sourced from the PageIndex reasoning-based retrieval over all ready documents.

#### Scenario: Ask a question about documents
- **WHEN** user types query in search box and submits
- **THEN** system SHALL POST to `/api/documents/query` with the query text
- **AND** SHALL display returned answer with source document names as citations

## REMOVED Requirements

### Requirement: WeKnora Knowledge panel at /weknora route
**Reason**: Replaced by local Pagesize Documents panel; no longer using remote WeKnora service.

**Migration**: Users access documents at `/documents` route instead of `/weknora`.
