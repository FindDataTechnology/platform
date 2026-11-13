## Context

`Platform` is a no-build, ESM Node app: an Express + WebSocket server hosting one shared pi agent session, with an optional LlamaIndex.TS document RAG module. Today the project's important information is scattered across file-based stores with no single source of truth:

- **Chat sessions** are persisted by the pi SDK's `SessionManager` as append-only JSONL under `sessions-store/` (the server tracks one in-memory current session and does not write a parallel store). Each session has id, title, created/updated timestamps via SDK metadata.
- **Documents** are persisted by `documents.js` as a hand-rolled `documents-store/manifest.json` (atomic temp+rename) plus per-doc folders holding LlamaIndex `SummaryIndex` data (`doc_store.json`, `index_store.json`) and `source.txt`. Indexing runs in a serialized queue with per-doc failure isolation; status transitions broadcast as `documents_status` WS events.
- **User preferences** have no store at all.

The document engine was **previously** the `pageindex` npm library (a vectorless, reasoning-based RAG - a TypeScript port of VectifyAI/PageIndex), introduced by the archived `add-knowledge-collection` change, then **replaced by LlamaIndex.TS** by the `left-nav-docs-history` change. `pageindex` is no longer in `package.json`; `knowledge-store.archive/` is the old store.

The project's conventions (from `CLAUDE.md`) that this design must preserve: graceful degradation for every external/optional dependency; tokens never reach the browser; atomic persistence; new capabilities flow through `broadcast()` as typed WS events. This change reverts the PageIndex removal and introduces SQLite, while **keeping LlamaIndex.TS as the data-management framework** (per user direction: "use llamaindex as a framework, it can access the pageindex, can save data into pageindex, and also can read data from sqlite, do not remove it").

## Goals / Non-Goals

**Goals:**
- Make SQLite the single persistence layer for chat prompts & responses, document records & text, the document (PageIndex) index, and single-user preferences.
- Reintroduce `pageindex` as the document indexing layer, accessed **through** LlamaIndex.TS (kept as the framework). LlamaIndex orchestrates ingestion/readers, saves document data into PageIndex, and reads structured data from SQLite.
- Preserve all existing behavioral contracts: serialized indexing queue, per-doc failure isolation, SSRF protection, `documents_status` events, read-only/resume/switch chat-history API, WS event protocol.
- Migrate existing `documents-store/` and `sessions-store/` data into SQLite once, losslessly, idempotently.
- Preserve graceful degradation: a missing/unwritable DB logs a warning and the server still starts (chat in-memory without persistence, documents disabled).

**Non-Goals:**
- Multi-user accounts or authentication (single-user preferences only - no identity, no per-user isolation).
- Vector embeddings / `VectorStoreIndex` (PageIndex is vectorless reasoning RAG; no embedding endpoint is required, same as today's `NoopEmbedding` rationale).
- Removing LlamaIndex.TS (it stays as the framework).
- A remote/distributed database (SQLite is a local file; no Postgres/external DB).
- Migrating the legacy pre-SDK `chat-history-store/` (already superseded by `sessions-store/`; only `sessions-store/` is a migration source).
- Changing the WS event protocol or the browser-facing REST contracts.

## Decisions

### Decision 1: SQLite driver is `better-sqlite3`
**Choice:** `better-sqlite3`.
**Rationale:** Synchronous API matches this app's single-agent, low-concurrency model and keeps persistence code simple (no promise/callback plumbing). It ships prebuilt binaries for common platforms, avoiding a build toolchain in this no-build project, and is ESM-compatible.
**Alternatives considered:**
- `node:sqlite` (Node 22+ built-in): no native dep, but still experimental (flag-gated / shifting API in current Node). Rejected for stability in a project that "always starts."
- `sqlite3` (async/callbacks): rejected - adds complexity with no benefit at this concurrency level.

### Decision 2: Chat prompts are mirrored into SQLite (the SDK's `SessionManager` is sealed)
**Choice:** Mirror each user prompt and assistant response into SQLite on `prompt`/`done`. SQLite is the queryable store of record for the list/view API. The pi SDK's file-based `SessionManager` (JSONL under `sessions-store/`) remains the live agent's context/resume/branching store and the source for resume/switch.
**Rationale (confirmed by investigation):** `SessionManager` has a private constructor and is file-bound internally (`sessionFile`, `_persist`, `_rewriteFile`) - it cannot be subclassed or duck-typed into a SQLite-backed replacement the SDK would use for its internal `appendMessage` calls during agent turns. The primary path (custom SQLite `SessionManager`) is therefore infeasible; mirroring is the only option. The SDK's rich session features (branching, compaction, model/thinking changes) stay on JSONL; SQLite gives the queryable, unified project database the user asked for, with prompts/responses stored alongside documents and preferences.
**Alternatives considered:**
- Custom SQLite-backed `SessionManager` (store of record) - rejected: the SDK class is sealed.
- Keep JSONL as the only store, SQLite as a read-only index - rejected: the user wants prompts *in* SQLite as the project database, not merely indexed.

### Decision 3: PageIndex is integrated behind LlamaIndex via a bridge adapter (`pageindex-bridge.js`)
**Choice:** LlamaIndex.TS remains the framework. `pageindex-bridge.js` exposes PageIndex as a LlamaIndex-compatible indexing/retrieval surface: LlamaIndex's document readers parse PDF/Markdown/text/URL into LlamaIndex `Document`s; the bridge feeds their text into PageIndex for indexing and delegates retrieval to PageIndex. LlamaIndex reads source text from SQLite (a SQLite-backed document store) and the PageIndex index is persisted to SQLite.
**Rationale:** Matches the user's model ("LlamaIndex as framework, saves into PageIndex, reads from SQLite") and reuses the project's existing bridge pattern (`mcp-bridge.js` adapts MCP into pi; here `pageindex-bridge.js` adapts PageIndex into LlamaIndex). Investigation confirmed `pageindex` exposes **indexing only** (`PageIndex.fromPdf`, `markdownToTree`) producing a `PageIndexResult` tree (`TreeNode[]`); it has **no retrieval/query API**. The bridge therefore implements reasoning-based retrieval itself: flatten the tree, use the LLM to reason over node summaries to select relevant nodes, and return their text + the source doc name. LlamaIndex remains the framework for document reading/parsing and orchestration.
**Alternatives considered:**
- PageIndex standalone, LlamaIndex only for readers - rejected; user explicitly wants LlamaIndex as the managing framework.
- A full LlamaIndex `BaseIndex` subclass wrapping PageIndex - not available; PageIndex has no retrieval to delegate. The bridge is a thin indexer (PageIndex) + retriever (hand-rolled reasoning over the tree) + storage (SQLite JSON) adapter.

### Decision 4: PageIndex index is persisted to SQLite as JSON
**Choice:** Persist each document's PageIndex index (`PageIndexResult`, a JSON-serializable `TreeNode[]` tree) in SQLite `doc_index.index_data` as JSON, with `index_version`.
**Rationale:** Investigation confirmed `pageindex` exposes no pluggable storage backend; the result is a plain JSON-serializable object, so JSON-in-a-BLOB-column is the only option (no fallback needed). `index_version` lets future PageIndex format changes be detected and re-indexed from `source_text`.
**Alternatives considered:** Keep PageIndex indexes on disk in per-doc folders, SQLite for metadata only - rejected; the user wants the index in the project database.

### Decision 5: SQLite schema (single file, WAL, FKs on)
**Choice:** One database file (default `data/app.db`, overridable via `DB_PATH`), opened with `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`. Tables:
- `schema_migrations(version PK, applied_at)` - migration tracking.
- `chat_sessions(id PK, title, created_at, updated_at)` - session metadata.
- `chat_messages(id PK, session_id FK→chat_sessions, role, content, seq, created_at)` - prompts & responses, ordered by `seq`.
- `documents(id PK, name, type, status, added_at, error, source_text)` - migrated from `manifest.json` + `source.txt`.
- `doc_index(doc_id PK FK→documents, index_data BLOB, index_version, updated_at)` - PageIndex index per doc.
- `user_preferences(key PK, value, updated_at)` - single-user prefs/profile (key/value).
**Rationale:** Normalized, queryable, transactional. WAL gives concurrent readers alongside the serialized indexing writer. `user_preferences` as key/value avoids over-modeling a single-user, no-auth profile.

### Decision 6: Graceful degradation mirrors the optional-dependency pattern
**Choice:** At startup `db.js` opens (and migrates) the DB. If it cannot (missing dir, permissions, corrupt file), it logs a warning and exposes a `dbReady=false` flag. `server.js` then starts chat **in-memory without persistence** and leaves documents disabled, exactly as it starts today when the LLM provider is missing. The server always starts.
**Rationale:** Consistent with the project's "every external dependency is optional; a missing dependency logs a warning and the server continues" convention.

### Decision 7: Atomic persistence via SQLite transactions, not temp+rename
**Choice:** Document status transitions, manifest-equivalent updates, and chat appends are single SQLite transactions. The temp-file+rename `manifest.json` pattern is retired.
**Rationale:** SQLite transactions + WAL are crash-safe and simpler than hand-rolled atomic rename, and they unify all persistence.

## Risks / Trade-offs

- **[pi SDK `SessionManager` is sealed / file-based]** (confirmed) -> Mitigation: adopt the mirror approach (Decision 2); the SDK's JSONL stays for live-agent context/resume, SQLite mirrors prompts/responses as the queryable store of record. Resume/switch continue to use the SDK's JSONL.
- **[PageIndex has no retrieval API]** (confirmed) -> Mitigation: the bridge implements reasoning-based retrieval over the `PageIndexResult` tree (LLM reasons over node summaries, returns relevant node text + source). Scoped to Markdown first; retrieval quality tuned against the existing migrated docs.
- **[Bridge retrieval quality / cost]** -> Mitigation: retrieval calls the LLM once per query over a compact tree summary (titles + summaries), not full text; cap nodes returned. Falls back to returning top leaf nodes if LLM selection is empty.
- **[PageIndex index persistence format]** -> Mitigation: version the JSON (`index_version`) so future PageIndex format changes can be detected and re-indexed from `source_text`.
- **[`better-sqlite3` native binary unavailable on an exotic platform]** -> Mitigation: prebuilt binaries cover darwin/linux x64/arm64; document `npm install` as the only setup. `node:sqlite` remains a documented fallback.
- **[Migration re-indexing cost / partial failure]** -> Mitigation: migration imports metadata + `source_text` for all ready docs first, then re-indexes via PageIndex in the existing serialized queue with per-doc failure isolation; failures are marked `error`, not blocking. Migration is idempotent (skip already-present ids).
- **[Single shared agent + concurrent WS readers]** -> Mitigation: WAL mode + the already-serialized indexing queue keep write contention to one writer; reads are concurrent and non-blocking.
- **[Reverting a recent architectural decision (LlamaIndex replaced PageIndex)]** -> Mitigation: LlamaIndex is *not* removed, so the revert is additive (PageIndex returns behind LlamaIndex) rather than a destructive swap; the LlamaIndex-only path remains available if PageIndex integration proves unworkable.

## Migration Plan

1. Add `better-sqlite3` + `pageindex` deps; create `db.js` (open, WAL/FK pragmas, `schema_migrations`, schema v1).
2. Implement idempotent importer: on a fresh DB, if `documents-store/manifest.json` exists, import each document's record + `source.txt` into `documents`; if `sessions-store/*.jsonl` exist, import into `chat_sessions`/`chat_messages`. Legacy stores are left intact (not deleted).
3. Implement `pageindex-bridge.js`; swap `documents.js` to index via PageIndex-through-LlamaIndex and persist records/text/index to SQLite. Re-index migrated ready docs from `source_text`.
4. Implement the SQLite session store (Decision 2, primary or fallback); swap chat persistence off JSONL.
5. Add `user_preferences` + a minimal read/write API.
6. Wire `dbReady` graceful degradation into `server.js` startup.
7. E2E verify: migrated docs query correctly, new ingestion works, chat persists & resumes, prefs round-trip, server starts with DB disabled.
- **Rollback:** legacy `documents-store/` and `sessions-store/` are retained as migration sources (never deleted). Reverting the code restores file-based persistence; the SQLite file can be discarded.

## Open Questions

- ~~Does `@earendil-works/pi-coding-agent` expose a pluggable `SessionManager`/storage interface?~~ **Resolved (task 1.2):** No - `SessionManager` is sealed (private constructor, file-based JSONL). Mirror approach adopted (Decision 2).
- ~~Does `pageindex` expose a storage backend interface, or must the index be serialized to a BLOB?~~ **Resolved (task 1.2):** No storage backend; the `PageIndexResult` tree is JSON-serialized into `doc_index` (Decision 4). `pageindex` also has no retrieval API - the bridge implements reasoning-based retrieval over the tree (Decision 3).
- `DB_PATH` defaults to `data/app.db`, gitignored (confirmed in task 8.3).
