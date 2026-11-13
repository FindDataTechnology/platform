# document-management Delta

## ADDED Requirements

### Requirement: Ingestion completes locally without LLM calls

Adding a document SHALL extract its text locally (PDF, Markdown, text, office formats, URL fetch) and persist the extracted source text as part of the ingest operation. The document SHALL transition from `queued` directly to `ready` (or `error` with a specific message) without an intermediate LLM-backed indexing state. Ingest duration SHALL not depend on any external model provider.

#### Scenario: supported file upload

- **WHEN** a client uploads a supported file to the document add endpoint
- **THEN** the response returns after local extraction with the document already `ready` and its source text retrievable

#### Scenario: extraction failure

- **WHEN** a file cannot be parsed (corrupt or unsupported content)
- **THEN** the document is marked `error` with a message identifying the failure, and no partial source text is exposed

### Requirement: Ingestion has no platform LLM provider dependency

Document ingestion and library search SHALL NOT require any LLM API key, base URL, or model id configuration. Removing or misconfiguring platform LLM providers SHALL leave document upload, listing, preview, and deletion fully functional.

#### Scenario: no LLM key configured

- **WHEN** the server runs without any LLM provider configured
- **THEN** document upload, list, view-content, and delete all succeed

### Requirement: Interrupted uploads surface a resumable state on restart

On startup, documents stuck in a non-terminal state from a previous process SHALL be re-extracted from any persisted payload when available, or marked `error` with re-add guidance. No document SHALL remain in a non-terminal state across a restart.

#### Scenario: restart during ingest

- **WHEN** the server restarts while a document was mid-ingestion
- **THEN** after startup that document is either `ready` or `error`, never `queued` or `indexing`
