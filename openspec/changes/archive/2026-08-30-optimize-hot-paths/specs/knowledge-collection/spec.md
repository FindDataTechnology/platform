## MODIFIED Requirements

### Requirement: Collection retrieval by query

The system SHALL accept a natural-language query against the collection and return relevant content drawn from the indexed documents using reasoning-based retrieval over the persisted `pageindex` trees. The response SHALL attribute results to their source document(s). Per-document retrieval work (node selection and per-document answering) SHALL execute with bounded concurrency rather than strictly sequentially, and retrieval SHALL NOT load document `source_text` content it does not use; parsed index trees SHALL be cached in memory and invalidated when a document is re-indexed. Per-document failure isolation SHALL be preserved under parallel execution.

#### Scenario: Query returns relevant content with source

- **WHEN** a user queries the collection and matching content exists
- **THEN** the system returns an answer/excerpt and the name(s) of the source document(s)

#### Scenario: Query against empty collection

- **WHEN** a user queries the collection and no documents have been indexed
- **THEN** the system returns an empty result without error

#### Scenario: Multi-document query runs with bounded concurrency

- **WHEN** a query runs against a collection with several ready documents
- **THEN** at most a configured number of documents (default 3) are processed concurrently, with remaining documents queued
- **AND** one document's retrieval failure SHALL NOT abort the others

#### Scenario: Repeated queries reuse parsed index trees

- **WHEN** the same documents are queried again without modification
- **THEN** their serialized index trees SHALL be served from the in-memory cache without re-parsing from the database
