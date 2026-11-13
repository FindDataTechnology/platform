## ADDED Requirements

### Requirement: The project database is initialized at startup with schema migrations
The server SHALL initialize a single SQLite project database at startup (default `data/app.db`, overridable via `DB_PATH`), opened with write-ahead logging (`PRAGMA journal_mode=WAL`) and foreign keys enabled (`PRAGMA foreign_keys=ON`). The server SHALL track applied schema migrations in a `schema_migrations` table and SHALL apply any pending migrations transactionally before accepting writes. The database SHALL be the single persistence layer for chat messages, document records and source text, the document index, and user preferences.

#### Scenario: fresh database is created and migrated
- **WHEN** the server starts and the database file does not exist
- **THEN** the server SHALL create the database file
- **AND** SHALL apply all schema migrations in order, recording each in `schema_migrations`

#### Scenario: existing database is migrated forward
- **WHEN** the server starts against a database with some migrations already applied
- **THEN** the server SHALL apply only the pending migrations
- **AND** SHALL NOT re-apply already-recorded migrations

### Requirement: The project database degrades gracefully when unavailable
When the project database cannot be opened or migrated (missing directory, insufficient permissions, or a corrupt file), the server SHALL log a warning, expose a `dbReady=false` state, and SHALL continue to start. Chat SHALL remain available in-memory without persistence, document ingestion/query SHALL be disabled, and the server SHALL NOT abort startup. This mirrors the project's optional-dependency degradation pattern.

#### Scenario: database unavailable at startup
- **WHEN** the server cannot open or migrate the project database at startup
- **THEN** the server SHALL log a warning and start with `dbReady=false`
- **AND** chat SHALL work in-memory without persistence
- **AND** document ingestion and query SHALL be disabled

#### Scenario: database available at startup
- **WHEN** the project database opens and migrates successfully at startup
- **THEN** the server SHALL set `dbReady=true`
- **AND** chat persistence, document ingestion/query, and preferences SHALL be enabled

### Requirement: Chat messages, documents, the document index, and user preferences are persisted in the project database
The project database SHALL define tables for: `chat_sessions` (id, title, created_at, updated_at), `chat_messages` (id, session_id, role, content, seq, created_at), `documents` (id, name, type, status, added_at, error, source_text), `doc_index` (doc_id, index_data, index_version, updated_at), and `user_preferences` (key, value, updated_at). The `documents`, `chat-history`, and document-index modules SHALL persist through these tables and SHALL NOT maintain separate ad-hoc file stores as the source of record. All writes SHALL be transactional.

#### Scenario: chat message is stored
- **WHEN** a chat message is persisted
- **THEN** it SHALL be written to `chat_messages` with its session id, role, content, and ordering `seq`

#### Scenario: document record and index are stored
- **WHEN** a document is indexed
- **THEN** its record and source text SHALL be written to `documents` and its index to `doc_index`
- **AND** the writes SHALL occur within a single transaction

### Requirement: User preferences are stored and retrieved as single-user key/value entries
The server SHALL store a single user's preferences and profile (e.g. display name, settings) in the `user_preferences` table as key/value entries. There SHALL be no authentication and no multi-user isolation. The server SHALL expose a way to read and write preference entries; writes SHALL be idempotent on key.

#### Scenario: write a preference
- **WHEN** a preference key/value is written
- **THEN** the server SHALL upsert the row keyed by `key`
- **AND** a subsequent write to the same key SHALL replace its value

#### Scenario: read preferences
- **WHEN** the preferences are read
- **THEN** the server SHALL return the current key/value entries from `user_preferences`

### Requirement: Existing file-based stores are migrated into the project database once, idempotently
On startup against a fresh (empty) database, if legacy file-based stores exist (`documents-store/manifest.json` with per-doc `source.txt`, and `sessions-store/*.jsonl`), the server SHALL import them into the project database: document records and source text into `documents`, and chat sessions/messages into `chat_sessions`/`chat_messages`. The migration SHALL be idempotent (skipping ids already present) and SHALL leave the legacy stores intact on disk. Migrated ready documents SHALL be re-indexed through PageIndex from their imported `source_text`. Migration failures SHALL be logged per-item and SHALL NOT block startup.

#### Scenario: legacy documents are imported
- **WHEN** the server starts with a fresh database and `documents-store/manifest.json` exists
- **THEN** the server SHALL import each document's record and `source_text` into `documents`
- **AND** SHALL leave `documents-store/` intact on disk

#### Scenario: legacy chat sessions are imported
- **WHEN** the server starts with a fresh database and `sessions-store/*.jsonl` exist
- **THEN** the server SHALL import sessions and messages into `chat_sessions`/`chat_messages`
- **AND** SHALL skip any session id already present

#### Scenario: migration is not re-run
- **WHEN** the server starts against a database that already contains migrated data
- **THEN** the server SHALL NOT re-import from legacy stores
