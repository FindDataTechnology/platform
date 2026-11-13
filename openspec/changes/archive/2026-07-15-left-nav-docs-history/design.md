## Context

Platform currently exposes three views via header toggle buttons in `public/index.html` + `app.js` (`showView()`): Chat, Knowledge (PageIndex RAG via `knowledge.js`), and OpenConnector (a custom action-browse/execute panel that only manages API-key connections). There is one module-scoped pi agent `session` shared by all WS clients, no chat persistence, and the OpenConnector panel cannot manage OAuth connections.

Four requested capabilities do not fit the header-toggle model: (1) manage OpenConnector through its **own official web UI**, (2) a LlamaIndex-backed document store replacing PageIndex, (3) a documents management web page, and (4) chat history. This change restructures navigation into a left sidebar and adds all four.

Current state grounding:
- `knowledge.js` ingests PDF/Markdown/text/URL via the `pageindex` library (vectorless, reasoning-based RAG), persists to `knowledge-store/` with an atomic manifest, runs a serialized indexing queue, and broadcasts `knowledge_status` via an injected `broadcast` callback. `server.js` wires `/api/knowledge/*` routes + multer memory storage and calls `initStore({ baseUrl, apiKey, model, broadcast })` at startup.
- `open-connector.js` already proxies the runtime's JSON API with per-endpoint-family token selection (`runtime` for `/v1/*`+`/mcp`, `admin` for `/api/*`) and never forwards client `Authorization`.
- Deps in `package.json`: `pageindex`, `turndown` (URL→Markdown) will be removed; `multer` stays; `llamaindex`, `@llamaindex/openai`, `@llamaindex/readers` will be added.

Per Context7 (`/run-llama/llamaindexts`): LlamaIndex.TS configures an OpenAI-compatible LLM via `Settings.llm = new OpenAI({ model, apiKey, baseURL })` from `@llamaindex/openai`; readers live in `@llamaindex/readers` (`PDFReader`, `MarkdownReader`, `TextFileReader`, `HTMLReader`, `SimpleDirectoryReader`); indexing via `VectorStoreIndex.fromDocuments([...])` with a `storageContext`; querying via `index.asQueryEngine().query({ query })`.

## Goals / Non-Goals

**Goals:**
- Left sidebar nav with tabs: Chat, Chat History, Documents, OpenConnector (replaces header toggles).
- Embed OpenConnector's native web UI through a token-injecting server reverse proxy; tokens never reach the browser.
- LlamaIndex.TS document management (ingest PDF/MD/text/URL, index, persist, list, view content, delete, retrieve) replacing `knowledge.js`; preserve the serialized-queue + status-broadcast + atomic-manifest + restart-reconciliation patterns.
- Persist chat sessions to disk; list + view past sessions read-only.
- Preserve graceful degradation: missing LlamaIndex config or unreachable OpenConnector runtime never aborts server startup.

**Non-Goals:**
- Resume a past chat session into the live agent (view-only this change).
- Migrating existing `knowledge-store/` PageIndex indices into LlamaIndex (archived, not converted).
- Replacing the existing OpenConnector action-browse/execute panel (kept alongside the embedded web UI).
- Auth/multi-tenancy for chat history (single-user/local tool, same single-session model as today).

## Decisions

### D1: LlamaIndex index type = `SummaryIndex` + no-op embedding
PageIndex is vectorless (reasoning-based). `VectorStoreIndex` requires `Settings.embedModel`, and it is unverified whether the Volces provider exposes an embeddings endpoint. `SummaryIndex` (ListIndex) retrieves by feeding node text to the LLM rather than ranking by similarity, mirroring PageIndex behavior.

**Implementation finding:** LlamaIndex.TS's `SummaryIndex.fromDocuments` *does* still require an `embedModel` at indexing time (unlike the Python ListIndex). Because SummaryIndex retrieval ignores embedding similarity, a tiny no-op `BaseEmbedding` subclass (returns zero vectors) satisfies the requirement without a real embedding endpoint. The configured Volces provider is chat-only, so this avoids a hard dependency on an embeddings API. If real embeddings become available, swap in `OpenAIEmbedding` and consider `VectorStoreIndex` for similarity retrieval.
- **Alternative considered**: `VectorStoreIndex` + `SimpleVectorStore` persisted to disk - better retrieval at scale, but blocked on embeddings availability. Deferred.

### D2: LLM config reuses the existing Volces provider, set via `Settings`
`documents.js` receives `{ baseUrl, apiKey, model }` from `server.js` (same as `initStore` today) and sets `Settings.llm = new OpenAI({ model, apiKey, baseURL: baseUrl, temperature: 0.2 })` once at init. Like `knowledge.js`, it also sets `process.env.OPENAI_BASE_URL`/`OPENAI_API_KEY` because LlamaIndex's OpenAI client falls back to those for internal calls. `PAGEINDEX_MODEL` env var is renamed to `DOCUMENTS_MODEL` (default unchanged).

### D3: Persistence = per-doc storage directory + atomic manifest (mirror `knowledge.js`)
Each document gets `documents-store/<id>/` holding the LlamaIndex storage context (doc store + index), plus a `documents-store/manifest.json` written via temp-file + rename. Statuses `queued`/`indexing`/`ready`/`error` and restart reconciliation (mark interrupted docs `error`) are preserved. `documents_status` WS event replaces `knowledge_status`.

### D4: Readers from `@llamaindex/readers`; URL ingestion reuses the SSRF-safe fetch
PDF → `PDFReader`, Markdown → `MarkdownReader`, text → `TextFileReader` (or a `Document` from raw text). URL ingestion reuses `knowledge.js`'s `isPrivateHost` SSRF guard + 2 MB / 15 s fetch cap, then wraps the fetched HTML in a `Document` (or `HTMLReader`). `turndown` is removed.

### D5: OpenConnector web UI = reverse proxy at `/oc-web/*`, token injected per path family
Mount `GET /oc-web` and `GET|POST|... /oc-web/*` in `server.js` that forward to `<runtime>/<path>` using the same token-selection rule as `open-connector.js` (`admin` for the UI shell and `/api/*`, `runtime` for `/v1/*`+`/mcp`). Client-supplied `Authorization` is always stripped. The OpenConnector tab renders the proxy root in a same-origin `<iframe src="/oc-web">`. Reuse `open-connector.js`'s `runtimeFetch` plumbing; add a streaming pass-through for arbitrary content types (HTML, JS, CSS, JSON) so the native UI's assets load.
- **Alternative considered**: link out to the runtime URL directly - rejected, it leaks the admin token to the browser and breaks the project's token-protection invariant.

### D6: Iframe asset-path mitigation via `<base>` rewrite + root-level asset/API proxy
The runtime's UI (a Vite SPA, "OOMOL Connect") references assets with absolute paths (e.g. `/assets/index-*.js`) and makes same-origin absolute API calls (`/api/*`, `/v1/*`). `<base href="/oc-web/">` alone only fixes relative URLs. Mitigation: (a) inject `<base href="/oc-web/">` into the proxied HTML; (b) mount the proxy at root for the SPA's absolute path roots - `/assets/*`, `/v1/*`, and a `/api/*` catch-all registered **after** the app's own `/api/*` routes so they take precedence. This makes the embedded SPA fully functional without rebuilding it with a base path. Verified: `/assets/*` serves the JS bundle, `/api/connections` reaches the runtime with the admin token, and `/api/documents` / `/api/openconnector/*` still hit the app's own handlers.

### D7: Fallback if the runtime ships no usable web UI
If verification (first implementation task) shows the runtime has no browser dashboard, or it cannot be made to work behind the proxy, the OpenConnector tab keeps the existing panel and we add OAuth connect support to it (calling the runtime's OAuth endpoints through the existing `/api/openconnector/*` proxy). This keeps the user goal ("manage connectors incl. OAuth from the web") satisfied either way.

### D8: Chat history = one JSON file per session, server-appended
`chat-history-store/<sessionId>.json` = `{ id, title, createdAt, updatedAt, messages: [{role, content, ts}] }`. The server tracks a "current session" id in memory. On a `prompt` WS message it appends the user turn; on agent `done` it appends the concatenated assistant text. A `POST /api/chat-history/sessions` endpoint starts a new session. Title = first user message truncated. `GET /api/chat-history/sessions` lists metadata; `GET /api/chat-history/sessions/:id` returns messages. Atomic writes (temp + rename). No resume.

### D9: Sidebar nav shell in `index.html` + `app.js`
Replace the header toggle buttons with a `<nav class="sidebar">` (tab list) + `<main>` content area. `showView(name)` toggles the active panel and sets the active-tab class. Tabs: Chat, Chat History, Documents, OpenConnector. The OpenConnector tab internally sub-tabs between "Manage (embedded web)" and "Actions (existing panel)".

## Risks / Trade-offs

- **[OpenConnector runtime may not serve a web UI]** -> D7 fallback. Verify first; do not assume. Network to `github.com`/`raw.githubusercontent.com` was unavailable during planning, so the upstream README could not be confirmed - the first implementation task is to confirm against the running runtime at the configured `OPENCONNECTOR_BASE_URL`.
- **[Native UI breaks behind a path-prefixed proxy]** -> D6 `<base>` rewrite + broad asset proxy. If unfixable, D7 fallback.
- **[`SummaryIndex` retrieval quality / cost]** -> Feeds all node text to the LLM per query (like PageIndex today). Acceptable for a local tool with modest corpus size; bounded by reusing the existing node-text caps. Future switch to `VectorStoreIndex` if embeddings become available.
- **[LlamaIndex.TS is a large dependency; first import may be slow / heavy]** -> Acceptable; matches the "no-build ESM" constraint (LlamaIndex.TS ships ESM). Verify it loads under `node --experimental-vm-modules`? No - plain ESM, no build step needed. Confirm at import time in the first Documents task.
- **[Chat history for a shared single-agent session is ambiguous]** -> Modeled as server-tracked "current session" with explicit "new session" action; all clients share it (same as today's single session). Documented as a non-goal to fix multi-tenancy.
- **[BREAKING: `/api/knowledge/*` removed]** -> Migration plan below; clients using the old routes must move to `/api/documents/*`.
- **[Token leakage through the proxy]** -> Reuse `open-connector.js`'s strict token rules: only server-held tokens, never forward client `Authorization`, constrain proxy to the configured runtime host (no open redirect).

## Migration Plan

1. Add LlamaIndex deps; implement `documents.js`; add `/api/documents/*` routes; broadcast `documents_status`.
2. Add `chat-history.js` + `/api/chat-history/*` routes; wire append-on-prompt/done.
3. Add OpenConnector web proxy (`/oc-web/*`); verify against the running runtime (D7 fallback ready).
4. Restructure `index.html`/`app.js`/`style.css` to the sidebar nav; rename Knowledge panel → Documents; add Chat History and OpenConnector-manage tabs.
5. Remove `/api/knowledge/*` routes, the `knowledge_status` event, `knowledge.js`, and `pageindex`/`turndown` deps. Archive `knowledge-store/` to `knowledge-store.archive/` (do not delete user data).
6. Update `CLAUDE.md` (config/architecture sections) and `.env`/`mcp.example.json` docs.

**Rollback**: revert `server.js`/`public/` and reinstall `pageindex`/`turndown`; `knowledge-store/` is preserved under `.archive/`. The new `documents-store/` and `chat-history-store/` are additive and can be deleted.

## Open Questions

- Does the running OpenConnector runtime at `OPENCONNECTOR_BASE_URL` actually serve a browser dashboard? (Resolved by first implementation task; D7 fallback if not.)
- Does the Volces provider expose an embeddings endpoint? (Only relevant if D1 is later changed to `VectorStoreIndex`; not a blocker for `SummaryIndex`.)
- Should chat history also capture tool/thinking blocks, or only final text? (Default: final assistant text only, to keep files small and view-only UI simple.)
