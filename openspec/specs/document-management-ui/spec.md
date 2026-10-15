# document-management-ui Specification

## Purpose
Defines the React-based Documents page UI for managing document uploads, viewing status, and querying indexed documents.

## Requirements

### Requirement: Users can view the Documents panel at /documents route

The web application SHALL expose a `/knowledge` route (with `/documents` redirecting to it) that renders the React library page, accessible from the sidebar navigation. The page SHALL show the document list with status, upload affordances, content preview, delete, collections grouping, and a "Start conversation" action per file and per collection. The page SHALL NOT present a question/answer interface; conversation happens in the chat window.

#### Scenario: Navigate to Documents panel

- **WHEN** user clicks the knowledge nav item
- **THEN** the application SHALL navigate to the `/knowledge` route (`/documents` redirects there)
- **AND** SHALL render the library page component

#### Scenario: Page loads document list

- **WHEN** user opens the library route
- **THEN** the page SHALL fetch current document list via `/api/documents` endpoint
- **AND** SHALL display each document with id, name, type, status, and addedAt

#### Scenario: Start conversation actions are present

- **WHEN** the library page renders
- **THEN** each document row and each collection card exposes a "Start conversation" action that hands off to the chat composer, and no query input exists on the page

### Requirement: Users can upload documents via drag-drop or file picker

The library page SHALL accept uploads via (a) clicking the upload button/file picker, and (b) drag-and-drop files onto the chat input in any page. Files SHALL be auto-detected by extension and validated against supported types. Uploads resolve to terminal status in the upload flow (`ready` or `error` with a message); a non-terminal status lasting longer than a documented bound SHALL surface a visible warning.

#### Scenario: Drag-drop a PDF to chat input

- **WHEN** user drags a PDF file onto the Composer textarea
- **THEN** the system SHALL submit it to `/api/documents` endpoint
- **AND** SHALL show the attachment chip resolving to attached or failed based on the terminal response

#### Scenario: File picker upload

- **WHEN** user clicks upload button and selects multiple files
- **THEN** the system SHALL submit each file sequentially
- **AND** each SHALL appear in the list with its terminal status (`ready` or `error`), with no unbounded `indexing` state

### Requirement: Document status is tracked via WebSocket events

Document status transitions (`queued` → `ready` or `error`) SHALL be broadcast as `documents_status` WebSocket events where an async boundary still applies. The UI SHALL reflect status without polling; with synchronous ingest, the upload response itself carries the terminal status and events are a consistency mechanism.

#### Scenario: Status updates live in UI

- **WHEN** a document finishes ingestion
- **THEN** server SHALL emit a `documents_status` event with the terminal status
- **AND** the UI SHALL update that row's status badge accordingly
