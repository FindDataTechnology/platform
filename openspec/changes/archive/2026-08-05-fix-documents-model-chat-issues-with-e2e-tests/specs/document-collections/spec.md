## ADDED Requirements

### Requirement: Save collection button persists collection state
The server SHALL persist the collection state after documents are added. The "Save Collection" button SHALL trigger a save operation that ensures the collection and its document memberships are persisted to the database.

#### Scenario: save collection after adding documents
- **WHEN** user adds documents to a collection and clicks "Save Collection"
- **THEN** the collection and its memberships SHALL be persisted to the database
- **AND** the collection SHALL appear in the collections list with the correct document count

### Requirement: Collection document count updates immediately
The UI SHALL update the collection's document count immediately when documents are added or removed, without requiring a page refresh.

#### Scenario: document count updates on add
- **WHEN** a document is added to a collection
- **THEN** the displayed document count SHALL increment immediately

#### Scenario: document count updates on remove
- **WHEN** a document is removed from a collection
- **THEN** the displayed document count SHALL decrement immediately
