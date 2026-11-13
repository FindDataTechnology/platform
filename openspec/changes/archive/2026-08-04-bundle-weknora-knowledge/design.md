## Context

The Platform project is a browser-based chat interface around the pi-coding-agent SDK. It bundles LiteLLM (Python venv) and OpenConnector (Node/tsx) as localhost sidecar services spawned by the Electron supervisor. The current knowledge module (`documents.js`) uses PageIndex (vectorless, reasoning-based RAG via LlamaIndex.TS) and is not powerful enough for the target users (personal developers and small teams).

WeKnora (Tencent, open-source, ~19k stars) is a full knowledge platform with hybrid BM25+dense retrieval, 10+ document formats, task-queue-based ingestion, workspace RBAC, Wiki mode, and a web UI. It requires PostgreSQL + Redis. The project already has embedded PostgreSQL (from `bundle-postgres-embed-litellm`), so WeKnora can reuse it. Redis is the only new runtime to bundle.

The project follows a pattern for third-party servers: build script downloads binary into `resources/`, supervisor descriptor spawns it on a free port, health-checks it, restarts on failure. `server.js` mounts a token-injecting reverse proxy (`/oc-web`, `/litellm-web`) and the React SPA embeds it in an iframe. WeKnora follows this exact pattern.

## Goals / Non-Goals

**Goals:**
- Bundle WeKnora + Redis into the Electron desktop app (.dmg/.exe) so users get a fully self-contained knowledge platform with zero external dependencies.
- Reuse the existing embedded PostgreSQL (no second Postgres instance).
- Follow the established pattern: build script → supervisor descriptor → reverse proxy → iframe UI.
- Auto-provision WeKnora credentials (user never logs into WeKnora separately).
- Configure WeKnora's LLM/embedding to reuse the existing Volces provider (no new credentials).
- Replace the limited `documents.js` with WeKnora's full feature set.

**Non-Goals:**
- Automatic migration of existing `documents-store/` data to WeKnora (PageIndex format ≠ WeKnora format; users must re-ingest).
- Multi-user RBAC enforcement in the desktop app (WeKnora's RBAC is available but the desktop app auto-provisions a single service account; company teams sharing a remote WeKnora instance can use RBAC).
- Custom WeKnora UI modifications (use WeKnora's native web UI as-is via iframe).
- Supporting WeKnora as an npm library (it's a Go binary, not a Node module).

## Decisions

### 1. Bundle WeKnora as a sidecar service (like LiteLLM/OpenConnector)
**Decision:** Follow the established pattern: `scripts/build-weknora.js` downloads the WeKnora Go binary into `resources/weknora/`, supervisor descriptor spawns it on a free port, health-checks it, restarts on failure. `server.js` mounts `/weknora-web` reverse proxy (like `/oc-web`), React SPA embeds it in an iframe.

**Rationale:** Consistency with LiteLLM and OpenConnector. The supervisor machinery (`supervisor/descriptors.js`, `lifecycle.js`, `health.js`) already handles spawning, health-checking, and restarting child processes. The reverse-proxy pattern (`/oc-web`, `/litellm-web`) is proven. The iframe pattern (OpenConnector page, LiteLLM page) is proven. No new architectural patterns required.

**Alternatives considered:**
- **Embed WeKnora as an npm library**: WeKnora is a Go binary, not a Node module. Not feasible.
- **Run WeKnora as an external Docker service**: Breaks the "fully bundled, no external dependencies" desktop story. Users would need Docker installed.
- **Run WeKnora as a remote server**: Breaks the "local" requirement. Company teams can do this optionally (set `WEKNORA_BASE_URL` to a non-localhost URL), but the desktop app bundles it by default.

### 2. Reuse existing embedded PostgreSQL
**Decision:** WeKnora connects to the same embedded PostgreSQL instance that LiteLLM uses (from `bundle-postgres-embed-litellm`). WeKnora creates its own schema/tables in the same Postgres instance. No second Postgres required.

**Rationale:** Avoids doubling the Postgres packaging complexity (data dir, migrations, pgvector extension). The existing Postgres is already bundled, health-checked, and persisted to `PLATFORM_DATA_DIR/postgres/`. WeKnora just needs a database name + credentials.

**Alternatives considered:**
- **Bundle a second Postgres for WeKnora**: Doubles the packaging complexity, doubles the disk footprint, doubles the maintenance burden. Not justified when WeKnora can share the existing instance.

### 3. Bundle Redis (Memurai on Windows)
**Decision:** Bundle Redis as a sidecar service (like WeKnora). On macOS, use the official Redis binary. On Windows, use Memurai (commercial drop-in, ~$50/yr for dev) or the Microsoft archive port (unmaintained, free).

**Rationale:** WeKnora requires Redis for its task queue and caching. Redis has no official Windows build. Memurai is a commercial drop-in replacement that works on Windows. The Microsoft archive port is old and unmaintained but free. The project already bundles platform-specific binaries (Node, Python, Postgres), so adding Redis/Memurai follows the pattern.

**Alternatives considered:**
- **Use an in-memory task queue (no Redis)**: WeKnora is tightly coupled to Redis; not feasible without forking WeKnora.
- **Require users to install Redis separately**: Breaks the "fully bundled" story.
- **Use WSL2 on Windows**: Requires users to install WSL2; breaks the "just works" desktop story.

### 4. Auto-provision WeKnora credentials
**Decision:** On first launch, the supervisor generates a WeKnora API key and workspace, persists to `dev-settings.json` (like LiteLLM's `LITELLM_API_KEY` and OpenConnector's tokens). The user never logs into WeKnora separately — Platform handles auth transparently.

**Rationale:** Consistency with LiteLLM and OpenConnector. The desktop app is a single-user experience; the user shouldn't need to log into a separate system. WeKnora's RBAC is available for company teams sharing a remote instance, but the desktop app auto-provisions a service account.

**Alternatives considered:**
- **Proxy WeKnora's login UI**: User logs in once via WeKnora's native login. More flexible but breaks the "just works" story.
- **Hardcode a single API key**: Less secure; auto-generated is better.

### 5. Configure WeKnora's LLM/embedding via env vars
**Decision:** WeKnora needs an LLM + embedding model for indexing and retrieval. Reuse the existing Volces provider (OpenAI-compatible API) via env vars injected into WeKnora's process (like LiteLLM's `VOLCES_API_KEY`). No new credentials required.

**Rationale:** Consistency with LiteLLM (which also uses Volces). WeKnora supports OpenAI-compatible APIs, so Volces works out of the box. No new credentials required.

**Alternatives considered:**
- **Configure WeKnora's LLM via its admin UI**: User would need to log into WeKnora and configure it manually. Breaks the "just works" story.
- **Use a different LLM provider**: Would require new credentials; not justified when Volces already works.

### 6. Replace documents.js entirely (no migration)
**Decision:** Remove `documents.js`, `documents-store/`, `/api/documents/*` routes, `documents_status` WebSocket events, and the old React Documents page. Replace with WeKnora integration. Users with existing `documents-store/` data must re-ingest into WeKnora. No automatic migration path.

**Rationale:** PageIndex format ≠ WeKnora format. Writing a migration tool is complex and error-prone. The user base is small (early access), so re-ingestion is acceptable. Keeping both systems (documents.js + WeKnora) doubles the maintenance burden.

**Alternatives considered:**
- **Keep documents.js alongside WeKnora**: Doubles the maintenance burden, confuses users (which system to use?).
- **Write a migration tool (PageIndex → WeKnora)**: Complex, error-prone, not justified for a small user base.

## Risks / Trade-offs

**[Risk] WeKnora's Go binary is large (~100 MB per platform)** → Mitigation: acceptable given the value (full knowledge platform). Total bundled app size grows from ~600-800 MB to ~700-900 MB.

**[Risk] Redis on Windows requires Memurai (commercial, ~$50/yr) or the Microsoft archive port (unmaintained)** → Mitigation: Memurai is a commercial drop-in with a free dev license; the Microsoft archive port is old but works. Document both options; let the user choose.

**[Risk] WeKnora requires PostgreSQL + Redis; if either fails, WeKnora fails** → Mitigation: supervisor health-checks all three (Postgres, Redis, WeKnora) and restarts on failure. If Postgres or Redis is unavailable, WeKnora degrades gracefully (logs a warning, server starts without WeKnora).

**[Risk] WeKnora's native web UI may not match the Platform design** → Mitigation: acceptable; the iframe pattern (OpenConnector, LiteLLM) already accepts third-party UIs as-is. Users get WeKnora's full feature set (Wiki mode, RBAC, etc.) even if the UI doesn't match Platform's design.

**[Risk] WeKnora's LLM/embedding configuration may not work with Volces out of the box** → Mitigation: WeKnora supports OpenAI-compatible APIs; Volces is OpenAI-compatible. Test early; if it doesn't work, configure WeKnora to use a different provider (e.g., OpenAI, DeepSeek).

**[Risk] Users with existing documents-store/ data must re-ingest** → Mitigation: acceptable for a small user base (early access). Document the migration path clearly (delete old data, re-ingest into WeKnora).

**[Trade-off] Bundling WeKnora increases disk footprint by ~110 MB** → Acceptable given the value (full knowledge platform). Users who don't need knowledge can disable WeKnora (set `WEKNORA_BASE_URL` to empty).

**[Trade-off] WeKnora's RBAC is not enforced in the desktop app** → Acceptable; the desktop app is a single-user experience. Company teams sharing a remote WeKnora instance can use RBAC.
