## 1. Setup & investigation

- [x] 1.1 Add `better-sqlite3` and `pageindex` to `package.json` dependencies and run `npm install`
- [x] 1.2 Probe the `pageindex` API surface (indexing, retrieval, storage backend interface) and the `@earendil-works/pi-coding-agent` `SessionManager` pluggability; record findings to resolve design open questions (PageIndex storage backend; SQLite session store primary vs mirror) — FINDINGS: PageIndex has indexing only (no retrieval API, no storage backend; result is a JSON-serializable `PageIndexResult` tree → bridge must implement retrieval + serialize to SQLite). pi SDK `SessionManager` is a sealed class (private constructor, file-based JSONL) → cannot be subclassed/replaced; the mirror approach is the only feasible chat-persistence path. See pause report.

## 2. Project database core (`db.js`)

- [x] 2.1 Create `db.js`: open SQLite at `data/app.db` (overridable via `DB_PATH`), set `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`
- [x] 2.2 Implement a `schema_migrations` table + transactional, idempotent migration runner that applies pending migrations in order
- [x] 2.3 Add schema v1 tables: `chat_sessions`, `chat_messages`, `documents`, `doc_index`, `user_preferences` (with foreign keys per design)
- [x] 2.4 Implement graceful degradation: expose a `dbReady` flag; on open/migrate failure log a warning and do not abort startup
- [x] 2.5 Expose typed query helpers (insert/get/update/delete per table) consumed by the other modules

## 3. Legacy data migration importer

- [x] 3.1 Implement idempotent import of `documents-store/manifest.json` + per-doc `source.txt` into `documents` (skip ids already present)
- [x] 3.2 Implement idempotent import of `sessions-store/*.jsonl` into `chat_sessions`/`chat_messages` (skip ids already present)
- [x] 3.3 Run the importer only when the DB is fresh; leave legacy stores intact on disk; log per-item failures without blocking startup

## 4. PageIndex <-> LlamaIndex bridge (`pageindex-bridge.js`)

- [x] 4.1 Create `pageindex-bridge.js` adapting PageIndex into a LlamaIndex indexing/retrieval surface (LlamaIndex remains the framework)
- [x] 4.2 Wire LlamaIndex document readers (PDF, Markdown, text, URL) to feed parsed text into PageIndex via the bridge
- [x] 4.3 Persist each document's PageIndex index to SQLite `doc_index` (SQLite storage backend if PageIndex exposes one; otherwise versioned BLOB serialization with `index_version`)
- [x] 4.4 Validate end-to-end on one doc type (Markdown): ingest -> index -> query -> returns answer + source names

## 5. Document module swap (`documents.js`)

- [x] 5.1 Replace the LlamaIndex-only `SummaryIndex` indexing with PageIndex-through-LlamaIndex via `pageindex-bridge.js`
- [x] 5.2 Swap filesystem persistence (`manifest.json` + per-doc folders) for SQLite tables (`documents` record + `source_text` + `doc_index`) with transactional status writes
- [x] 5.3 Preserve the serialized indexing queue, per-doc failure isolation, SSRF protection, fetch size/duration caps, and HTTP(S) proxy honoring
- [x] 5.4 Preserve `documents_status` WebSocket broadcasts on each status transition (`queued`/`indexing`/`ready`/`error`)
- [x] 5.5 Update list/view/delete endpoints to read/write SQLite; keep delete idempotent (removes record, source text, and index row)
- [x] 5.6 On restart, reconcile any document left in `queued`/`indexing` to `error`

## 6. Chat persistence swap (`chat-history.js` / `server.js`)

- [x] 6.1 Implement the SQLite-backed session store: a custom `SessionManager` if the SDK is pluggable, otherwise mirror prompts/responses into SQLite on `prompt`/`done`
- [x] 6.2 Wire the session store so the user message is persisted on `prompt` and the assistant's final message on turn completion (`done`), advancing the session update timestamp
- [x] 6.3 Source the session list/view/resume/switch operations from SQLite, preserving most-recently-updated ordering and excluding message bodies from the list
- [x] 6.4 Verify resume/switch still load message history into the live agent context and broadcast `session_loaded`

## 7. User preferences

- [x] 7.1 Add a read/write API for `user_preferences` (key/value, idempotent upsert on key)
- [x] 7.2 Surface preferences to the UI (or apply as server-side defaults) within the existing panel/tab pattern

## 8. Server wiring & graceful degradation

- [x] 8.1 Initialize `db.js` at startup before feature modules; gate document ingestion/query and chat persistence on `dbReady`
- [x] 8.2 Verify the server starts with the DB disabled (chat in-memory without persistence, documents disabled)
- [x] 8.3 Add `data/app.db` (and respect `DB_PATH`) to `.gitignore`

## 9. Verification

- [x] 9.1 Verify migration: legacy `documents-store/` and `sessions-store/` import correctly and migrated ready docs re-index and query
- [x] 9.2 Verify new ingestion across PDF/Markdown/text/URL, status broadcasts, and idempotent delete
- [x] 9.3 Verify chat persists, lists, resumes, and switches from SQLite
- [x] 9.4 Verify user preferences round-trip
- [x] 9.5 Verify the graceful-degradation path (DB unavailable -> server starts, chat in-memory, documents off)
- [x] 9.6 Extend the E2E suite (`e2e-testing`) to cover document persistence and chat persistence against SQLite
