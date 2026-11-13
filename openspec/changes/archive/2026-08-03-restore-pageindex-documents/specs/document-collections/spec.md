## ADDED Requirements

### Requirement: Users can create, list, rename, and delete document collections
The server SHALL expose endpoints for collection CRUD operations. Each collection has an id (UUID), name, description, documentCount, and createdAt. Collections are addressed by id in all APIs; names need not be unique. Deleting a collection SHALL be idempotent (succeeds even if collection is already deleted).

#### Scenario: Create a collection
- **WHEN** user provides a name to collection create endpoint
- **THEN** the server SHALL create a new collection with auto-generated id
- **AND** SHALL return the created collection's metadata including id and createdAt

#### Scenario: List collections with counts
- **WHEN** user calls collection list endpoint
- **THEN** the server SHALL return each collection with its documentCount (number of member documents)
- **AND** SHALL sort by creation date descending

#### Scenario: Rename a collection
- **WHEN** user provides new name/description to collection update endpoint
- **THEN** the server SHALL update the collection's name and/or description
- **AND** SHALL return the updated collection metadata

#### Scenario: Delete a collection is idempotent
- **WHEN** user deletes a collection and then attempts to delete it again
- **THEN** both requests SHALL succeed without error
- **AND** the second call SHALL NOT raise "collection not found" error

### Requirement: Users can add and remove documents from collections
The server SHALL expose endpoints to add a document to a collection and to remove a document from a collection. Adding a document that is already a member SHALL be a no-op (idempotent). Adding a non-existent document or adding to a non-existent collection SHALL return HTTP 404 error. Removing a document that is not a member SHALL be a no-op (idempotent).

#### Scenario: Add document to collection
- **WHEN** client adds an existing document to an existing collection
- **THEN** the server SHALL create the membership record
- **AND** SHALL return the collection's updated documentCount

#### Scenario: Add same document twice
- **WHEN** client adds a document to a collection where it is already a member
- **THEN** the server SHALL NOT create duplicate membership
- **AND** SHALL succeed (HTTP 200, no error)

#### Scenario: Remove document from collection
- **WHEN** client removes a member document from a collection
- **THEN** the server SHALL remove the membership row
- **AND** SHALL return the collection's updated documentCount

### Requirement: Users can query within a specific collection
The server SHALL expose an endpoint to query over only the `ready` documents that are members of the specified collection, returning an answer and source document names. If the collection has no ready documents, the server SHALL return an empty answer with no sources.

#### Scenario: Query a collection with ready documents
- **WHEN** client posts a query against a collection that has ready member documents
- **THEN** the server SHALL retrieve via PageIndex reasoning over only those ready members
- **AND** SHALL return an answer with source document names used

#### Scenario: Query a collection with no ready documents
- **WHEN** client posts a query against a collection with no ready documents
- **THEN** the server SHALL return empty answer with no sources
- **AND** SHALL NOT attempt retrieval over other document sets
