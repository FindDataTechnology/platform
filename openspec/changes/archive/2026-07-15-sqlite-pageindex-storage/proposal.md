## Why

The project scatters its important information across fragile, file-based stores with no single source of truth: chat sessions live as SDK-managed JSONL under `sessions-store/`, documents live as a hand-rolled `manifest.json` plus per-doc LlamaIndex folders under `documents-store/`, and there is no structured store for user preferences at all. Each store reinvents its own crash-safety (atomic temp+rename), its own listing/query API, and its own reconciliation-on-restart logic. Consolidating prompts & responses, document records & text, the document index, and user preferences into one SQLite database gives the project a queryable, transactionally-safe, unified data layer - and reintroducing `pageindex` as the indexing layer behind LlamaIndex.TS (kept as the data-management framework) restores the project's original, purpose-built RAG engine.

## What Changes

- Introduce a **SQLite project database** as the single persistence layer for the project's important information. A new `db.js` module owns connection lifecycle, schema migrations, and graceful degradation (a missing/unwritable DB file logs a warning and the server continues with chat disabled, mirroring the existing optional-dependency pattern).
- **Reintroduce the `pageindex` npm library** as the document indexing layer, accessed **through LlamaIndex.TS, which remains the data-management framework and is NOT removed**. LlamaIndex orchestrates: it saves document data into PageIndex and reads structured data back from SQLite. A new `pageindex-bridge.js` module adapts PageIndex into LlamaIndex's storage/retrieval surface (the same bridge pattern used by `mcp-bridge.js`).
- **Migrate document persistence to SQLite**: document records (id, name, type, status, addedAt, error) and extracted source text move from `documents-store/manifest.json` + per-doc `source.txt` into SQLite tables; the PageIndex index data is persisted in SQLite rather than per-doc folders. The serialized indexing queue, per-doc failure isolation, SSRF protection, and `documents_status` broadcast behavior are preserved.
- **Migrate chat persistence to SQLite**: chat prompts & responses move out of the pi SDK's JSONL session files (`sessions-store/`) into SQLite, via a SQLite-backed session store that the SDK writes through. The read-only list/view/resume/switch API contract is preserved.
- Add **single-user preferences/profile storage** in SQLite (display name, settings) - no authentication, no multi-tenancy.
- Provide a **one-time migration** of existing `documents-store/` and `sessions-store/` data into SQLite on first run, so no user data is lost.
- **BREAKING** (internal): the `documents-store/` and `sessions-store/` directory layouts are superseded by the SQLite database file; the file-based stores become migration sources only.

## Capabilities

### New Capabilities
- `project-database`: A SQLite-backed single persistence layer for the project's important information. Owns database lifecycle (init, migrations, graceful degradation), the schema for all persisted entities (chat messages, document records & text, document index, user preferences), and the contract that other modules persist through it rather than their own ad-hoc files.

### Modified Capabilities
- `document-management`: The indexing engine requirement changes - LlamaIndex.TS remains the framework but PageIndex is reintroduced as the indexing layer LlamaIndex saves document data into (reversing the prior "replacing the former PageIndex-based knowledge module" wording). The persistence requirement changes from per-doc storage directories + atomic `manifest.json` to SQLite tables (document records, source text, and PageIndex index data) managed by `project-database`.
- `chat-history`: The message-persistence requirement changes from the pi SDK's JSONL session files under `sessions-store/` to SQLite tables managed by `project-database` (written through a SQLite-backed session store). The list/view/resume/switch session contract is unchanged.

## Impact

- **Dependencies**: add `pageindex` (reintroduced; brings transitive `openai`, `pdf-parse`, `pdf-poppler` - Poppler optional for scanned-PDF OCR) and a SQLite driver (`better-sqlite3` primary - synchronous, prebuilt binaries, ESM-compatible; `node:sqlite` built-in as an alternative, decided in design). LlamaIndex.TS is **kept**; nothing is removed.
- **New files**: `db.js` (SQLite init/migrations/schema + graceful degradation), `pageindex-bridge.js` (LlamaIndex <-> PageIndex adapter), and a `migrations/` set of SQL.
- **Modified files**: `documents.js` (swap LlamaIndex-only indexing for PageIndex-via-LlamaIndex; swap filesystem persistence for SQLite), `chat-history.js` / the session wiring in `server.js` (SQLite-backed session store), `server.js` (init `db.js` at startup, gate features on DB readiness).
- **Data**: a new gitignored database file (e.g. `data/app.db`) holds all persisted state; existing `documents-store/` and `sessions-store/` are migrated once then superseded.
- **LLM cost**: PageIndex indexing calls the configured LLM per document (hierarchical reasoning index), as the prior `pageindex`-based module did - reuses the existing Volces provider config, no new credentials.
- **No breaking changes to chat behavior or the WS event protocol**; persistence is swapped underneath the existing contracts.
