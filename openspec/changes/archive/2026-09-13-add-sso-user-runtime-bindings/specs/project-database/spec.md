## MODIFIED Requirements

### Requirement: Chat messages, documents, the document index, and user preferences are persisted in the project database

The project database SHALL define tables for: `chat_sessions` (id, title, created_at, updated_at), `chat_messages` (id, session_id, role, content, seq, created_at), `documents` (id, name, type, status, added_at, error, source_text), `doc_index` (doc_id, index_data, index_version, updated_at), and `user_preferences` (key, value, updated_at). The `documents`, `chat-history`, and document-index modules SHALL persist through these tables and SHALL NOT maintain separate ad-hoc file stores as the source of record. All writes SHALL be transactional. The existing `user_preferences` table SHALL remain the global, single-user preference store. Identity-scoped model and MCP bindings SHALL use separate email-keyed tables and SHALL NOT be stored as global preference keys.

#### Scenario: chat message is stored
- **WHEN** a chat message is persisted
- **THEN** it SHALL be written to `chat_messages` with its session id, role, content, and ordering `seq`

#### Scenario: document record and index are stored
- **WHEN** a document is indexed
- **THEN** its record and source text SHALL be written to `documents` and its index to `doc_index`
- **AND** the writes SHALL occur within a single transaction

#### Scenario: global preference remains global
- **WHEN** a global preference is written
- **THEN** it SHALL be stored in `user_preferences` and SHALL NOT be scoped to an SSO email

#### Scenario: personal bindings use separate rows
- **WHEN** two authenticated users save different model or MCP bindings
- **THEN** each user's rows are stored under their normalized email
- **AND** the global `user_preferences` rows remain unchanged

## ADDED Requirements

### Requirement: Schema migration adds email-keyed runtime binding tables

A new schema migration SHALL create `user_model_bindings` with a primary key of normalized email and columns for provider id, model id, and update time, and `user_mcp_bindings` with a composite primary key of normalized email and MCP name plus an enabled flag and update time. The migration SHALL add an index on the MCP binding email. Existing databases SHALL migrate transactionally and SHALL retain all existing preferences, chat, document, and MCP configuration rows. The migration SHALL be idempotent and recorded in `schema_migrations`.

#### Scenario: fresh database receives binding tables
- **WHEN** the server starts with a fresh database
- **THEN** the migration creates both email-keyed binding tables and records the migration

#### Scenario: existing database migrates forward
- **WHEN** the server starts with a database created before the binding tables existed
- **THEN** only the pending migration runs
- **AND** existing data remains readable and unchanged

#### Scenario: binding writes are transactional
- **WHEN** a model or MCP binding is saved
- **THEN** the corresponding row is upserted atomically with its update timestamp
