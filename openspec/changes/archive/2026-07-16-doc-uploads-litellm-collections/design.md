## Context

The platform's document pipeline today accepts four types - PDF, Markdown, plain text, URL - via `POST /api/documents` (multer `memoryStorage`, 50 MB cap). Multipart type is decided by extension (`.pdf` -> `pdf`, **everything else -> `markdown`**), which silently mis-classifies unsupported files. `pageindex-bridge.js` parses PDF via `PageIndex.fromPdf`, Markdown via `markdownToTree`, and text/URL via `simpleTree`; the extracted text and the PageIndex tree are persisted to SQLite (`documents`, `doc_index`). `@llamaindex/readers`, `@llamaindex/openai`, and `llamaindex` are already listed in `package.json`. Drag-and-drop and clipboard paste reuse the same endpoint and extension mapping.

The model list is produced by the `list_models` WebSocket handler from the SDK's model registry, scoped by `EXPOSED_PROVIDERS`. The LiteLLM proxy is registered as the `litellm` provider via the `pi-provider-litellm` extension when `LITELLM_BASE_URL` + `LITELLM_API_KEY` are set; the proxy at `http://192.168.1.4:4000` exposes an OpenAI-compatible `GET /v1/models` returning four ids (`deepseek-chat`, `volc-coding-deepseek-v4-flash`, `volc-coding-deepseek-v4-pro`, `volc-coding-glm-5.2`). `pi --list-models | grep litellm` confirms the pi-agent recognizes exactly these four, so the proxy's `/v1/models` is an authoritative, live source that the SDK registry only mirrors at startup.

Documents are a flat list in the `documents` table; the query endpoint retrieves over all `ready` documents. There is no grouping concept. The project database (`data/app.db`, WAL, migration runner) already holds `chat_sessions`, `chat_messages`, `documents`, `doc_index`, and `user_preferences`.

## Goals / Non-Goals

**Goals:**
- Broaden accepted upload types (`.docx`, `.csv`, `.html`/`.htm`, `.json`) using `@llamaindex/readers`, feeding the existing PageIndex -> SQLite pipeline, across both the Documents-tab picker and chat-window drag-and-drop/paste. (PPTX is out of scope: `@llamaindex/readers` has no PPTX reader.)
- Reject unsupported file types explicitly (HTTP 415) instead of silently classifying them as Markdown.
- Make the LiteLLM model list live and authoritative by sourcing it from the proxy's `/v1/models` endpoint, consumed by the model selector and the `/model` command, with graceful fallback.
- Add document collections: create/list/rename/delete, add/remove documents, list members, and query within a collection, persisted in SQLite.

**Non-Goals:**
- Attaching a collection as automatic RAG context to a chat session (future work).
- Embedding/vector retrieval (PageIndex remains vectorless/reasoning-based).
- Auto-migrating existing documents into collections.
- Changing LiteLLM provider registration itself (still `pi-provider-litellm`).
- Supporting every LlamaIndex reader - scoped to docx/csv/html/json, extensible later.

## Decisions

### 1. LlamaIndex readers as the parsing layer for new types
New file types are parsed by the matching `@llamaindex/readers` reader to extract text, which is then handed to PageIndex (`simpleTree`, or `markdownToTree` for HTML) and persisted exactly like existing types. PDF keeps `PageIndex.fromPdf` (page-aware) and Markdown keeps `markdownToTree` (structure-aware). A new `readers.js` adapter (or an extension of `pageindex-bridge.js`) maps extension -> reader -> extracted text.
- **Rationale**: reuses the existing PageIndex->SQLite pipeline; readers own format complexity (docx xml, csv, html sanitization, json). `@llamaindex/readers` is already a dependency.
- **Alternatives**: pure PageIndex (rejected - no readers for docx/csv/etc.); shell out to pandoc/unrtf (rejected - external runtime dependency, breaks graceful degradation).

### 2. Single supported-extension set, explicit rejection
A single server-side set of supported extensions (`.pdf`, `.md`, `.markdown`, `.docx`, `.csv`, `.html`, `.htm`, `.json`) is the source of truth. The upload route returns HTTP 415 for any other extension instead of the current `.pdf ? pdf : markdown` fallback. The client mirrors this set in the picker `accept` and in drag-drop/paste type inference.
- **Rationale**: fixes the silent mis-classification bug; one source of truth prevents client/server drift.
- **Alternatives**: per-MIME allowlist (rejected - MIME is spoofable and less stable than extension for these formats); keep silent fallback (rejected - produces garbled docs).

### 3. Model list sourced live from LiteLLM `/v1/models`
When LiteLLM is configured, `list_models` fetches `GET ${LITELLM_BASE_URL}/v1/models` (Bearer `LITELLM_API_KEY`), maps `data[].id` to `{id, provider:"litellm"}`, deduplicates, and returns them. A short in-memory TTL cache (default ~30 s) avoids hitting the proxy on every refresh. On fetch failure/timeout, fall back to the configured-provider models that have configured auth. The selector and `/model` validation consume this list unchanged.
- **Rationale**: live and authoritative - models added via the LiteLLM admin UI appear without a server restart. `pi --list-models` confirmed parity, so no runtime subprocess is needed.
- **Alternatives**: shell out to `pi --list-models` at runtime (rejected - subprocess overhead, harder to degrade gracefully); cache at startup only (rejected - stale vs. admin-UI changes); keep SDK registry as source (rejected - drifts from proxy).

### 4. Collections schema and access pattern
Two new tables via an additive schema migration:
- `collections (id TEXT PK, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL)`
- `collection_documents (collection_id TEXT, document_id TEXT, added_at TEXT, PRIMARY KEY(collection_id, document_id), FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE, FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE)`

`PRAGMA foreign_keys=ON` (already set) makes document deletion cascade-remove memberships. Query-by-collection reuses the existing `queryCollection` retrieval but restricts to the collection's member doc ids. REST routes under `/api/collections/*` (list/create/rename/delete, members add/remove/list, query). The Documents tab gains a Collections UI. No new WebSocket event - mutations are synchronous, so the HTTP response plus a UI refetch suffice (unlike async document indexing, which needs `documents_status`).
- **Rationale**: matches existing SQLite/migration patterns and the project's atomic-persistence convention; simplest correct live-update model.
- **Alternatives**: a `collection_id` column on `documents` (rejected - a document can belong to many collections); WS broadcast for collections (rejected - unnecessary for synchronous mutations).

### 5. Reader peer dependencies, added incrementally
Some LlamaIndex readers require optional peer dependencies (e.g. `mammoth` for `.docx`). These are added during implementation. If a reader's peer dep fails to install or is too heavy, that type is excluded from the supported set and logged, rather than aborting startup - preserving graceful degradation.
- **Rationale**: keeps the server starting even if one reader's dep is unavailable.

## Risks / Trade-offs

- **[Reader peer-dep bloat / install failures]** -> Mitigation: add types incrementally; if a reader dep fails, exclude that type and log; server still starts.
- **[LiteLLM `/v1/models` latency/failure on list_models]** -> Mitigation: short TTL cache + bounded timeout + fallback to configured-provider models; never abort the request.
- **[Model id drift between proxy and pi-agent]** -> Mitigation: design-time parity confirmed via `pi --list-models`; `/model <unknown>` validates against the fetched list and returns an error (existing behavior).
- **[Unsupported-type rejection changes drag-drop behavior]** -> Mitigation: intended change; previously such files were silently garbled. Surface a clear UI notice.
- **[Collection query over many docs]** -> Mitigation: scoping to a collection reduces the set vs. the current all-docs query; reuses existing per-doc retrieval.

## Migration Plan

- **Database**: additive migration only (new `collections` + `collection_documents` tables); no data movement, no legacy import. Existing documents and chats are unaffected.
- **Deploy**: `npm install` for any new reader peer deps; restart the server. The new tables are harmless if the feature is later reverted (empty, or droppable).
- **Model list**: backward-compatible - still returns models; only the source changes. If LiteLLM is unconfigured, behavior is unchanged.
- **Rollback**: revert code; additive DB tables can be left in place or dropped without affecting existing data.

## Open Questions

- Which LlamaIndex readers require extra peer dependencies, and are those deps acceptable in this project? Resolve during the first implementation task (probe readers).
- Should the model-list cache TTL be configurable via env? Default ~30 s; decide during implementation.
- Future follow-up: attach a collection to a chat session as automatic RAG context? Out of scope here.
