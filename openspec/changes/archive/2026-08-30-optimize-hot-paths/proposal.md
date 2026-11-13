## Why

Static analysis found four likely-user-visible performance defects. (1) **Boot**: `server.listen` is the LAST statement of a fully sequential await chain — static assets and health probes are unreachable until dsh spawns + handshakes (up to 10s of retries), legacy migrations run, and the catalog's cloud fetch completes (10s timeout); the supervisor documents ~50s cold starts. (2) **RAG queries are O(2N+1) sequential LLM round trips** — `queryCollection` awaits 2 LLM calls per ready document serially (10 docs = 21 calls, minutes of latency), loads every document's full `source_text` then never uses it, and re-parses every serialized index tree per query with no cache. (3) **~1.3MB of uncompressed JS/wasm ships on first paint** — no `compression` middleware (634KB entry + 622KB wasm raw), no route-level code splitting (all pages eagerly imported), and 4.5MB of production sourcemaps sit in `web/dist`. (4) **Every streamed token re-renders the entire transcript** — turn components aren't memoized, so O(history) reconciliation per delta, plus string-concat growth per token. Fourth and final change in the optimisation sequence — lands after the server split and persistence unification so its edits hit small files.

## What Changes

- **Boot (listen-first)**: start HTTP listening immediately after cheap middleware wiring; run initialization groups in parallel (`db`+stores | dsh agent | legacy migration | catalog | cron) with chat-dependent endpoints/WS commands answering a `initializing` state until the dsh agent is ready; catalog's cloud fetch never blocks readiness (serve local catalog immediately, merge cloud on arrival).
- **RAG query path**: per-document LLM selection+answer calls run with bounded concurrency (default 3–4) instead of sequentially; `listReadyDocuments` for retrieval selects `id, name` only (no `source_text`); parsed PageIndex trees cached in-memory keyed by `doc_id` + `updated_at` (invalidated on re-index).
- **Transport/bundle**: add `compression` middleware for static serving; `React.lazy` route-level code splitting in `App.tsx` (shiki's fine-grained lazy imports stay as-is); production sourcemaps switch to `hidden` (built for error reporting, not shipped/downloadable).
- **Chat hot path**: memoize `AssistantTurn`/`UserTurn` (identity already preserved by the mutation strategy), subscribe `ChatPage` to `turns.length` instead of the array, batch streamed text deltas (~50ms/rAF flush) before store commits; hoist better-sqlite3 `prepare()` calls to module-level constants in `db.js`; `@doc:` expansion selects `substr(source_text,1,12000)` instead of the full column.
- **Startup import diet**: `documents.js`/`pageindex-bridge.js`/`readers.js` heavyweight imports (`llamaindex`, readers, `undici`) become lazy `import()` at first use.
- Explicit non-goals: no embeddings/vector retrieval (linear LLM retrieval stays, just parallel + slimmed), no worker-thread PDF indexing, no virtualized transcript, no further locale lazy-loading.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `web-chat-server`: static serving requirement gains HTTP compression; new requirement that the server listens before background initialization completes and that initialization groups run concurrently with graceful `initializing` responses.
- `knowledge-collection`: retrieval requirement gains bounded-concurrency parallel per-document retrieval and no-unused-blob loading (behavior for a single-document collection is unchanged).

## Impact

- **Backend**: `server.js` boot section (post-split), `server/routes/*` (readiness gating), `catalog.js` (non-blocking cloud fetch), `pageindex-bridge.js`, `documents.js`, `readers.js`, `db.js` (prepared statements + substr variant), new dep `compression`.
- **Frontend**: `App.tsx` (lazy routes), `useChatStore.ts` (delta batching), `Chat.tsx`/`ChatPage.tsx`/`AssistantTurn.tsx`/`UserTurn.tsx` (memoization + selectors), `vite.config.ts` (sourcemap hidden).
- **Compatibility risks handled**: WS/UI must tolerate a `dsh_unavailable`-style initializing window (supervisor already tolerates slow boots via 120s timeout; k8s probes get a listening server sooner — strictly better); `@doc:` truncation at 12,000 chars matches the current slice behavior (server.js:250) but at the SQL layer.
- Gates: all four changes' CI (lint/typecheck/unit/locales/build/e2e-fast) must be green; e2e `chat-polish`, `model-selection`, documents/collections specs cover the touched flows.
