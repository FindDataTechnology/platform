# document-search-index Delta

## Purpose

Local, deterministic search infrastructure for the document library: documents are chunked at ingest and indexed into an SQLite full-text index so library tools can answer lexical queries without any LLM or embedding dependency.

## ADDED Requirements

### Requirement: Documents are chunked and full-text indexed at ingest

When a document reaches `ready` status, the system SHALL split its extracted source text into chunks and record them in a full-text index keyed by document id. Chunking and indexing SHALL require no LLM calls and SHALL complete within the ingest request lifecycle for files up to the supported size cap. Deleting a document SHALL delete its chunks.

#### Scenario: upload completes with searchable chunks

- **WHEN** a supported file is uploaded and text extraction succeeds
- **THEN** the document reaches `ready` status with its chunks queryable in the full-text index in the same operation, with no intermediate `indexing` state

#### Scenario: deletion removes index entries

- **WHEN** a user deletes a document from the library
- **THEN** no chunk of that document SHALL remain in the full-text index, and subsequent searches SHALL not return it

### Requirement: Existing source text is backfilled on startup

On server startup, the system SHALL ensure every `ready` document with source text has chunks in the full-text index. The backfill SHALL be idempotent (re-running produces no duplicate chunks) and SHALL skip documents already indexed. A backfill failure for one document SHALL not block others.

#### Scenario: first boot after upgrade

- **WHEN** the server starts with pre-existing `ready` documents that have source text but no chunks
- **THEN** their chunks are built and searchable without user action, and a second startup performs no duplicate work

### Requirement: Lexical search returns ranked chunk hits

A search over the library SHALL return matching chunks ranked by full-text relevance, each carrying the document id, document name, and a character offset or locator into the document's source text. Searches SHALL filter optionally by collection or document. An empty or no-match query SHALL return an empty result list, not an error.

#### Scenario: search hits across documents

- **WHEN** a query term appears in two library documents
- **THEN** the search returns ranked chunk hits from both documents with names and locators sufficient to read the surrounding text

#### Scenario: no matches

- **WHEN** a query matches no chunk
- **THEN** the search returns an empty list with a success status
