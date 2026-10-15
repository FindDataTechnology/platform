# knowledge-collection-ui Specification

## Purpose
TBD - created by archiving change add-knowledge-collection. Update Purpose after archive.

## Requirements

### Requirement: Knowledge Collection panel

The UI SHALL provide a "Knowledge Collection" panel accessible from the main chat interface. The panel SHALL be the single place where users add documents, monitor indexing, browse the collection, and query it.

#### Scenario: Open the Knowledge panel

- **WHEN** the user opens the Knowledge Collection panel
- **THEN** the panel displays the current collection and the controls to add documents and run queries

### Requirement: Add documents of multiple types

The UI SHALL let users add documents by: uploading a file (PDF or Markdown), pasting plain text into a text area, or entering a web page URL. The UI SHALL determine the document type from the input (file extension or explicit URL/text selection).

#### Scenario: Upload a PDF or Markdown file

- **WHEN** the user selects a PDF or `.md` file via the file picker and submits
- **THEN** the UI sends the file to the backend for indexing and a new document entry appears in the collection

#### Scenario: Submit pasted plain text

- **WHEN** the user types or pastes text into the notes area and submits
- **THEN** the UI sends the text to the backend and a new document entry appears in the collection

#### Scenario: Submit a URL

- **WHEN** the user enters a URL and submits
- **THEN** the UI sends the URL to the backend and a new document entry appears in the collection

### Requirement: Auto-save indication and live status

The UI SHALL communicate that added documents are auto-saved and auto-indexed (no manual save control) and SHALL display live, per-document indexing status driven by WebSocket events: `queued`, `indexing`, `ready`, `error`.

#### Scenario: Status transitions to ready

- **WHEN** a document's indexing completes
- **THEN** the UI updates that document's status indicator from `indexing` to `ready` without a page reload

#### Scenario: Error status shown

- **WHEN** a document fails to index
- **THEN** the UI shows an `error` status and the error message for that document

### Requirement: Browse and manage the collection

The UI SHALL list every saved document with its name, type, status, and added date, and SHALL allow the user to remove a document from the collection.

#### Scenario: Collection populated from server

- **WHEN** the panel is opened
- **THEN** the UI requests and displays the current collection list from the backend

#### Scenario: Remove a document

- **WHEN** the user removes a document from the UI
- **THEN** the UI requests deletion from the backend and the document disappears from the list

### Requirement: Query the collection with source attribution

The UI SHALL provide a query input where the user asks a natural-language question. On submit, the UI SHALL display the returned answer/excerpt and the source document name(s).

#### Scenario: Query displays answer and source

- **WHEN** the user submits a query and results are returned
- **THEN** the UI shows the answer/excerpt and the name(s) of the source document(s)

#### Scenario: Empty result

- **WHEN** the user submits a query and no relevant content exists
- **THEN** the UI indicates that no results were found

### Requirement: Reconnect resilience

The UI SHALL recover from transient WebSocket disconnects by re-fetching the collection list on reconnect so the displayed collection stays consistent with the server.

#### Scenario: Reconnect refreshes the collection

- **WHEN** the WebSocket reconnects after a drop
- **THEN** the UI re-fetches and refreshes the collection list
