## MODIFIED Requirements

### Requirement: E2E suite covers app shell navigation
The suite SHALL verify the sidebar contains all current navigation tabs and that switching between tabs works correctly.

#### Scenario: sidebar shows current navigation tabs
- **WHEN** the app loads
- **THEN** the sidebar SHALL show the navigation tabs including chat, dashboard, documents, openconnector, and litellm

## ADDED Requirements

### Requirement: E2E suite covers dashboard tab
The suite SHALL verify the dashboard tab loads and displays its content correctly.

#### Scenario: dashboard tab loads and displays content
- **WHEN** the user clicks the Dashboard tab
- **THEN** the dashboard view SHALL be displayed
- **AND** SHALL contain the expected dashboard content

### Requirement: E2E suite covers LiteLLM web UI tab
The suite SHALL verify the LiteLLM tab loads and displays its content correctly.

#### Scenario: LiteLLM tab loads and displays content
- **WHEN** the user clicks the LiteLLM tab
- **THEN** the LiteLLM view SHALL be displayed
- **AND** SHALL contain the expected LiteLLM content

### Requirement: E2E suite verifies SQLite persistence
The suite SHALL verify document metadata and preferences are persisted to SQLite and survive server restart.

#### Scenario: document list is served from SQLite database
- **WHEN** a document is created
- **THEN** it SHALL appear in the document list
- **AND** the document SHALL persist in the SQLite database

#### Scenario: preferences round-trip through the API
- **WHEN** a preference is saved
- **THEN** the same value SHALL be returned when queried

### Requirement: E2E suite covers collections functionality
The suite SHALL verify collections can be created, documents added to collections, and collections can be listed and deleted.

#### Scenario: collections CRUD operations
- **WHEN** a collection is created
- **THEN** it SHALL appear in the collections list
- **WHEN** a document is added to a collection
- **THEN** the document SHALL be listed under that collection
- **WHEN** a document is removed from a collection
- **THEN** the document SHALL NOT appear under that collection
- **WHEN** a collection is deleted
- **THEN** it SHALL NOT appear in the collections list
