## ADDED Requirements

### Requirement: Documents view provides ingestion and querying

The React Documents view at `/documents` SHALL let the user ingest documents (file upload, plain-text paste, URL fetch), view the document list with ingestion status, inspect a document's source content, and query a single document or a collection. It SHALL replace the legacy vanilla Documents + Collections tabs.

#### Scenario: Upload a file
- **WHEN** the user selects a `.md`/`.pdf`/`.txt` file and clicks Upload
- **THEN** the view SHALL POST the file to `/api/documents/upload`
- **AND** the document SHALL appear in the list with status `queued`, then transition through `indexing` to `ready` as `documents_status` WS events arrive

#### Scenario: Add a note from pasted text
- **WHEN** the user pastes plain text and clicks Add note
- **THEN** the view SHALL POST the text to `/api/documents/text`
- **AND** the document SHALL appear in the list

#### Scenario: Add a URL
- **WHEN** the user enters a URL and clicks Add URL
- **THEN** the view SHALL POST the URL to `/api/documents/url`
- **AND** on success the document SHALL appear in the list
- **AND** if the URL is private/blocked (SSRF), the view SHALL surface the server's error

#### Scenario: Ingestion status updates live
- **WHEN** a `documents_status` WS event arrives for a document
- **THEN** the list row for that document SHALL update its status badge without a page reload

#### Scenario: Query a single document
- **WHEN** the user enters a question in a document's query box and submits
- **THEN** the view SHALL POST to `/api/documents/:id/query`
- **AND** the synthesized answer and source names SHALL render below the query box

#### Scenario: View document source
- **WHEN** the user clicks a document in the list
- **THEN** the document's source text SHALL render in a content pane

### Requirement: Collections view provides grouping and querying

The React Documents view SHALL include a Collections section where the user can create a collection, list collections, open a collection detail (its member documents), add a document to a collection, delete a collection, and query a collection.

#### Scenario: Create a collection
- **WHEN** the user enters a name and optional description and clicks Create
- **THEN** the view SHALL POST to `/api/collections`
- **AND** the new collection SHALL appear in the collections list

#### Scenario: Add a document to a collection
- **WHEN** the user selects a document from the dropdown in a collection detail and clicks Add
- **THEN** the view SHALL POST to `/api/collections/:id/documents`
- **AND** the document SHALL appear in the collection's member list

#### Scenario: Query a collection
- **WHEN** the user enters a question in a collection's query box and submits
- **THEN** the view SHALL POST to `/api/collections/:id/query`
- **AND** the synthesized answer with source document names SHALL render

#### Scenario: Delete a collection
- **WHEN** the user clicks Delete on a collection and confirms
- **THEN** the view SHALL DELETE `/api/collections/:id`
- **AND** the collection SHALL disappear from the list

### Requirement: Documents view degrades when the document module is disabled

When `/api/config` reports documents are disabled (no provider or no DB), the Documents view SHALL render a clear "Documents unavailable" placeholder instead of the upload/list UI, and SHALL not attempt ingestion requests.

#### Scenario: Documents disabled
- **WHEN** the document module is not configured
- **THEN** the Documents view SHALL show a disabled-state message
- **AND** SHALL NOT send upload/query requests
