## ADDED Requirements

### Requirement: Collections are persisted in the project database and degrade gracefully
The server SHALL persist document collections (id, name, optional description, createdAt) and collection-document memberships (collectionId, documentId) in the project SQLite database. When the project database is unavailable, the server SHALL disable the collection endpoints and start normally with chat and other behavior unchanged. Deleting a document SHALL cascade-remove its memberships from every collection. Deleting a collection SHALL remove its memberships but SHALL NOT delete the member documents.

#### Scenario: database ready
- **WHEN** the server starts with the project database ready
- **THEN** the server SHALL mount the `/api/collections/*` endpoints

#### Scenario: database unavailable
- **WHEN** the server starts with the project database unavailable
- **THEN** the server SHALL start normally without mounting collection ingestion
- **AND** SHALL log a notice that collections are disabled
- **AND** chat and other behavior SHALL remain unchanged

#### Scenario: deleting a document removes its memberships
- **WHEN** a document that is a member of one or more collections is deleted
- **THEN** the server SHALL remove every membership row referencing that document
- **AND** the collections themselves SHALL remain

#### Scenario: deleting a collection leaves documents intact
- **WHEN** a collection is deleted
- **THEN** the server SHALL remove the collection and its membership rows
- **AND** SHALL NOT delete any document that was a member

### Requirement: Users can create, list, rename, and delete collections
The server SHALL expose endpoints to create a collection (name required, description optional), list collections (each with id, name, description, documentCount, createdAt), rename a collection (name and/or description), and delete a collection. Collection names need not be unique; collections are addressed by id. Deleting a collection SHALL be idempotent.

#### Scenario: create a collection
- **WHEN** a client posts a name to the collection create endpoint
- **THEN** the server SHALL create a collection and return its id, name, description, and createdAt

#### Scenario: list collections with counts
- **WHEN** a client calls the collection list endpoint
- **THEN** the server SHALL return each collection with its documentCount (number of member documents)

#### Scenario: rename a collection
- **WHEN** a client renames a collection by id
- **THEN** the server SHALL update the name and/or description and return the updated collection

#### Scenario: delete a collection is idempotent
- **WHEN** a client deletes a collection by id and then deletes the same id again
- **THEN** both requests SHALL succeed

### Requirement: Users can add and remove documents to/from a collection
The server SHALL expose endpoints to add a document to a collection and to remove a document from a collection. Adding a document that is already a member SHALL be a no-op (idempotent). Adding a non-existent document or adding to a non-existent collection SHALL return an error. Removing a document that is not a member SHALL be a no-op (idempotent).

#### Scenario: add a document to a collection
- **WHEN** a client adds an existing document to an existing collection
- **THEN** the server SHALL create the membership and return the collection's updated documentCount

#### Scenario: adding the same document twice is idempotent
- **WHEN** a client adds a document to a collection in which it is already a member
- **THEN** the server SHALL NOT create a duplicate membership
- **AND** SHALL succeed

#### Scenario: add a non-existent document
- **WHEN** a client adds a document id that does not exist to a collection
- **THEN** the server SHALL return an error and SHALL NOT create a membership

#### Scenario: remove a document from a collection
- **WHEN** a client removes a member document from a collection
- **THEN** the server SHALL remove the membership and return the collection's updated documentCount

#### Scenario: removing a non-member is idempotent
- **WHEN** a client removes a document that is not a member of the collection
- **THEN** the server SHALL succeed without error

### Requirement: Users can list a collection's documents
The server SHALL expose an endpoint to list the documents in a collection, returning each document's id, name, type, status, and addedAt, without index payloads.

#### Scenario: list a collection's documents
- **WHEN** a client lists the documents of a collection by id
- **THEN** the server SHALL return the member documents' metadata in the order they were added

### Requirement: Users can query within a collection
The server SHALL expose a query endpoint that retrieves over only the `ready` documents that are members of the specified collection and returns an answer and the source document names used. Retrieval SHALL use the same PageIndex-through-LlamaIndex retrieval as the collection-wide document query. If the collection has no `ready` documents, the server SHALL return an empty answer with no sources.

#### Scenario: query a collection with ready documents
- **WHEN** a client posts a query against a collection that has ready member documents
- **THEN** the server SHALL retrieve over only those ready members via PageIndex through LlamaIndex
- **AND** SHALL return an answer and the list of source document names used

#### Scenario: query a collection with no ready documents
- **WHEN** a client posts a query against a collection that has no ready documents
- **THEN** the server SHALL return an empty answer with no sources
