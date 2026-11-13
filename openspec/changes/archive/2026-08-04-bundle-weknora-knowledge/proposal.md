## Why

The current `documents.js` knowledge module (PageIndex-based, vectorless RAG) is not powerful enough for the project's target users — personal developers and small teams need enterprise-grade retrieval accuracy, multi-format ingestion (Word, Excel, PPT, images), scale (thousands of documents), and team collaboration features. WeKnora (Tencent, open-source, ~19k stars) is a full knowledge platform with hybrid BM25+dense retrieval, 10+ document formats, a task-queue-based ingestion pipeline, workspace RBAC, Wiki mode, and a web UI. Bundling WeKnora into the Electron desktop app (alongside the existing LiteLLM and OpenConnector) replaces the limited documents.js with a production-grade knowledge system while keeping the project's "fully bundled, no external dependencies" desktop story intact.

## What Changes

- **Add WeKnora as a bundled sidecar service** (like LiteLLM and OpenConnector): the Electron supervisor spawns the WeKnora Go binary on a free port, health-checks it, and restarts it on failure. WeKnora connects to the **existing embedded PostgreSQL** (from the `bundle-postgres-embed-litellm` change) — no second Postgres instance.
- **Add Redis as a bundled sidecar service**: WeKnora requires Redis for its task queue and caching. Bundle a Redis binary (or Memurai on Windows) and spawn it alongside WeKnora.
- **Add build scripts** (`scripts/build-weknora.js`, `scripts/build-redis.js`) that download the WeKnora Go binary and Redis binary into `resources/weknora/` and `resources/redis/` for macOS (arm64 + x64) and Windows (x64).
- **Add `weknora.js`**: a thin HTTP client for WeKnora's REST API (like `open-connector.js`), exposing methods for knowledge base management, document ingestion, and retrieval. Tokens stay server-side; the browser never sees them.
- **Mount `/weknora-web` iframe proxy** in `server.js` (like `/oc-web` for OpenConnector and `/litellm-web` for LiteLLM): reverse-proxies WeKnora's native web UI with token injection, so the React SPA can embed it in an iframe.
- **Replace the React Documents page** with an iframe wrapper pointing to `/weknora-web` (like the OpenConnector and LiteLLM pages). Remove the old `/documents` route's first-party React implementation.
- **Remove `documents.js`** and its dependencies: delete the PageIndex-based knowledge module, the `documents-store/` directory, `/api/documents/*` REST routes, and `documents_status` WebSocket events. **BREAKING**: users with existing `documents-store/` data must re-ingest into WeKnora.
- **Add `.env` config**: `WEKNORA_BASE_URL` (localhost URL for bundled WeKnora, e.g. `http://localhost:8080`), `WEKNORA_API_KEY` (auto-generated or user-provided). When set to a localhost URL, the supervisor spawns bundled WeKnora; when set to a non-localhost URL, use a remote WeKnora instance (graceful degradation).
- **Auto-provision WeKnora credentials**: on first launch, the supervisor generates a WeKnora API key and workspace, persists to `dev-settings.json` (like LiteLLM's `LITELLM_API_KEY` and OpenConnector's tokens). The user never logs into WeKnora separately — Platform handles auth transparently.
- **Configure WeKnora's LLM**: WeKnora needs an LLM + embedding model for indexing and retrieval. Reuse the existing Volces provider (OpenAI-compatible API) via env vars injected into WeKnora's process (like LiteLLM's `VOLCES_API_KEY`). No new credentials required.

## Capabilities

### New Capabilities
- `weknora-integration`: Backend module that bundles WeKnora (Go binary) + Redis as sidecar services, spawns them via the Electron supervisor, connects WeKnora to the existing embedded PostgreSQL, auto-provisions credentials, configures the LLM/embedding provider, and exposes WeKnora's REST API through a thin HTTP client (`weknora.js`) with token-injecting reverse proxy routes (`/weknora-web`, `/api/weknora/*`).
- `weknora-ui`: React iframe wrapper page at `/weknora` that embeds WeKnora's native web UI via the `/weknora-web` same-origin proxy (like the OpenConnector and LiteLLM pages). Replaces the old first-party Documents page.

### Modified Capabilities
- `documents` (existing): **BREAKING** — remove the PageIndex-based `documents.js` module, its REST routes, WebSocket events, and React UI. Replace with WeKnora integration. Users with existing `documents-store/` data must re-ingest into WeKnora.

## Impact

- **Dependencies**: add WeKnora Go binary (~100 MB per platform), Redis binary (~5-10 MB per platform). No new npm dependencies. WeKnora's Go binary is cross-compiled for macOS arm64/x64 and Windows x64. Redis on Windows requires Memurai (commercial drop-in, ~$50/yr) or the Microsoft archive port (unmaintained).
- **New files**: `weknora.js` (HTTP client), `scripts/build-weknora.js` (downloads WeKnora binary), `scripts/build-redis.js` (downloads Redis binary), `resources/weknora/` and `resources/redis/` directories, supervisor descriptors for WeKnora + Redis, React `/weknora` route.
- **Modified files**: `server.js` (mount `/weknora-web` proxy, `/api/weknora/*` routes, init WeKnora client), `supervisor/descriptors.js` (add WeKnora + Redis descriptors), `scripts/start.js` (spawn WeKnora + Redis when `WEKNORA_BASE_URL` is localhost), `web/src/App.tsx` (add `/weknora` route), `.env` (add `WEKNORA_BASE_URL`, `WEKNORA_API_KEY`).
- **Removed files**: `documents.js`, `documents-store/` (user data, gitignored), `/api/documents/*` routes in `server.js`, `documents_status` WebSocket events, old React Documents page components.
- **Disk footprint**: +~110 MB installed (WeKnora ~100 MB + Redis ~10 MB). Total bundled app size grows from ~600-800 MB to ~700-900 MB.
- **PostgreSQL**: WeKnora shares the existing embedded Postgres (from `bundle-postgres-embed-litellm`). WeKnora creates its own schema/tables in the same Postgres instance. No second Postgres required.
- **LLM cost**: WeKnora calls the configured LLM for indexing and retrieval (same Volces provider). No new credentials, but indexing cost increases with document count.
- **Migration**: users with existing `documents-store/` data must re-ingest into WeKnora. No automatic migration path (PageIndex format ≠ WeKnora format).
- **No breaking changes to chat behavior**: the knowledge module is additive (replaces Documents panel only). Chat, OpenConnector, LiteLLM panels are unaffected.
