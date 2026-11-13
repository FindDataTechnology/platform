## Context

`pi-web-chat` is an Express + WebSocket server (`server.js`) that wraps the `@earendil-works/pi-coding-agent` SDK and serves a vanilla HTML/CSS/JS frontend from `public/`. It registers a custom OpenAI-compatible provider ("volces") and an optional LiteLLM provider, and it already bridges MCP: `mcp-bridge.js` reads `mcp.json` at startup, connects each declared MCP server (stdio via `command`/`args`/`env`, or HTTP/SSE via `url`/`headers`), discovers tools via `listTools()`, and registers each as a pi `ToolDefinition` added to the agent session's `tools` allowlist. Failed servers are skipped without blocking startup. An existing `broadcast()` helper pushes events to WebSocket clients, and the knowledge-collection feature (`knowledge.js`) established the project's additive-module pattern: backend module + REST endpoints + WS events + a toggled UI panel.

[OpenConnector](https://github.com/oomol-lab/open-connector) (oomol-lab, Apache-2.0) is a separately-run connector gateway - an alternative to Composio. It connects 1,000+ SaaS providers and exposes their Actions to agents while keeping provider credentials inside its own runtime boundary. It is reached through several surfaces, all returning a uniform JSON envelope `{ success, message, data, meta }`:

- **MCP** at `POST /mcp` - a stateless JSON-RPC endpoint (no long-lived `GET` SSE stream) exposing a small discovery toolset: `list_apps`, `search_actions`, `get_action_guide`, `execute_action`. Metadata preview at `GET /mcp/tools`.
- **HTTP runtime API** under `/v1/*` - `GET /v1/health`, `GET /v1/providers`, `GET /v1/actions` (+ `?service=`, `?q=` search, `GET /v1/actions/:actionId`), `POST /v1/actions/:actionId` to execute (body `{"input":{}}`, connection selected via `x-oo-connector-alias` header or `?alias=`), plus `/v1/apps`, `/v1/proxy/:service`.
- **Admin API** under `/api/*` - `GET /api/providers[/:service]`, `GET /api/actions[/:actionId]/agent.md`, `GET/PUT/DELETE /api/connections/:service` (PUT body `{ authType, values, connectionName? }`), OAuth configs (`/api/oauth/configs[/:service]`, `POST /api/oauth/authorizations`), runtime tokens, and `GET /api/runs` for run logs.

Auth: callers of `/v1/*` and `/mcp` send `Authorization: Bearer oct_...` (a runtime token); admin endpoints under `/api/*`, `/docs`, and the console use `OOMOL_CONNECT_ADMIN_TOKEN`. The runtime stores state in `./data/connect.sqlite` by default and binds to `127.0.0.1`; it is run via Docker Compose, Node, Fly.io, Cloudflare Workers, or OOMOL's hosted runtime.

This change makes pi-web-chat a client of an externally-run OpenConnector runtime: the agent gains the runtime's MCP tools, and users get a web panel to browse the catalog, configure connections, and debug Actions. pi-web-chat does not embed, fork, or duplicate the gateway.

## Goals / Non-Goals

**Goals:**
- Let the pi-agent call any connected provider's Actions by registering the OpenConnector runtime's MCP endpoint (`<base>/mcp`) as an agent MCP server, built from env config and merged into the existing `mcp-bridge.js` connect step.
- Let users browse providers and Actions (with search), inspect an Action's schema and agent guide, manage API-key connections, and execute an Action for debugging - all from a new "OpenConnector" web panel.
- Keep runtime/admin tokens server-side only; the browser never sees them and never calls the runtime directly.
- Be fully additive and env-gated: when `OPENCONNECTOR_BASE_URL` is unset the server starts exactly as today (mirror the LiteLLM provider pattern).
- Reuse the project's existing patterns (Express REST, vanilla-JS toggled panel) and the existing MCP bridge rather than introducing a parallel tool-registration path.

**Non-Goals:**
- Embedding, forking, or bundling the OpenConnector runtime inside pi-web-chat. It is a prerequisite run separately.
- Duplicating runtime state in pi-web-chat (connections, credentials, runs, tokens live in the runtime; pi-web-chat holds no persistent state for this feature).
- Generating one pi tool per Action (the catalog has 10,000+ Actions). v1 uses OpenConnector's native 4-tool MCP discovery set.
- Full in-browser OAuth callback handling. v1 can start an authorization (the runtime returns an `authorizationUrl`) and store an OAuth client config, but the callback lands on the runtime's `/oauth/callback`; completing OAuth end-to-end inside pi-web-chat is deferred.
- Transit-file uploads, provider raw-proxy (`/v1/proxy/*`), runtime-token management UI, and per-action allow/block policy UI (configure these on the runtime side).
- Live WebSocket streaming of action execution (v1 is request/response over REST; streaming is a possible later addition).
- Auth/multi-user: single shared runtime connection, consistent with the single in-memory chat session.

## Decisions

### 1. Connect to an external runtime over HTTP; do not embed the gateway

**Choice:** `open-connector.js` is a thin HTTP client to a separately-run OpenConnector runtime, configured by `OPENCONNECTOR_BASE_URL` + optional `OPENCONNECTOR_RUNTIME_TOKEN` + `OPENCONNECTOR_ADMIN_TOKEN`.

**Why:** OpenConnector has its own deployment model (Docker/Node/Fly/Cloudflare/hosted), its own storage (SQLite/D1), its own credential encryption and OAuth boundary, and its own admin console. Embedding or forking it would duplicate all of that and couple pi-web-chat to its internals. Treating it as an external service via its documented HTTP/MCP API keeps the boundary clean and lets users choose any deployment (including OOMOL hosted).

**Alternatives considered:** Vendor the open-connector source as a sub-project and run it in-process (heavy coupling, duplicated state, version drift); call OOMOL's hosted runtime only (loses self-host option; the hosted service requires an account).

### 2. Raw `fetch` instead of the Connector SDK

**Choice:** Use Node's global `fetch` (Node 18+) to call the runtime; no new npm dependency.

**Why:** The runtime API is simple REST with a uniform `{success,message,data,meta}` envelope, and pi-web-chat already runs on a Node version with global fetch. The [Connector SDK](https://github.com/oomol-lab/connector-sdk) is a thin TypeScript HTTP client - useful, but adding it introduces a dependency and release-coupling for behavior we can cover with a few fetch wrappers in `open-connector.js`. Keeping it dependency-free matches the project's minimal-stack ethos.

**Alternatives considered:** Depend on `connector-sdk` (slightly less boilerplate, but new dep + coupling; its self-host `OpenConnector` client shape would still need to be verified against the installed version).

### 3. Agent-side integration via the runtime's native MCP endpoint, not per-action pi tools

**Choice:** Register OpenConnector's `POST /mcp` as an http MCP server (one server, four tools: `list_apps`, `search_actions`, `get_action_guide`, `execute_action`). The agent discovers and executes Actions through `execute_action`.

**Why:** This is exactly the discovery-oriented contract OpenConnector's MCP is designed for, and it maps directly onto the existing `mcp-bridge.js` path (http transport -> `listTools()` -> pi `ToolDefinition`s -> added to the session allowlist). The alternative - generating one pi tool per Action from `/v1/actions` - would flood the agent with 10,000+ tools and require filtering/syncing; it is a poor v1.

**Alternatives considered:** Generate per-action pi tools from `/v1/actions` (unbounded tool list, sync/allowlist complexity - defer to a possible v2 with scoped subsets); call `/v1/actions/:id` directly from a single hand-written pi tool (loses the MCP discovery UX and duplicates logic the runtime already exposes via MCP).

### 4. Merge the OpenConnector MCP server into `mcp-bridge.js` from env config

**Choice:** Refactor `mcp-bridge.js` backward-compatibly: extract `connectServers({ mcpServers })` (takes a config object) from the existing `connectMcpServers(configPath)` (which reads the file then delegates). `server.js` builds the OpenConnector MCP server config from env - `{ url: "<base>/mcp", headers: { Authorization: "Bearer <runtime token>" } }` when enabled - merges it with the `mcp.json` servers, and connects all through one call.

**Why:** Reuses the existing connection + tool-discovery + allowlist-registration path with no parallel mechanism. Building the server from env means enabling OpenConnector needs no `mcp.json` edit and no restart-beyond-startup. The refactor is additive: `connectMcpServers(path)` keeps its signature and behavior.

**Trade-off:** The MCP SDK's `StreamableHTTPClientTransport` may attempt a `GET` SSE stream that OpenConnector's stateless `POST /mcp` does not keep open. If the handshake fails at apply, fall back to registering the four OpenConnector tools as pi `customTools` that call `/mcp` (or `/v1`) via `fetch` directly, bypassing `mcp-bridge` for OpenConnector only. (See Risks.)

**Alternatives considered:** Write the OpenConnector entry into `mcp.json` at startup (mutates a user-managed file, clashes with manual edits); register OpenConnector tools entirely outside `mcp-bridge` (duplicates transport/timeout/error-handling logic).

### 5. Proxy the runtime API through pi-web-chat REST; tokens stay server-side

**Choice:** Add `/api/openconnector/*` endpoints on the Express server. Each endpoint calls the runtime with the appropriate token (runtime token for `/v1/*` + execute, admin token for `/api/*`) and returns the runtime's envelope/data to the browser. A `GET /api/openconnector/config` endpoint returns only `{ enabled, baseUrl }` - never tokens.

**Why:** Keeps runtime/admin tokens off the client (the browser cannot leak or abuse them), avoids CORS against the runtime, gives a single config source, and matches how `server.js` already holds provider keys at module scope. The web panel and the agent both ultimately go through the runtime's credential boundary, so provider secrets are never exposed to the agent process or the browser.

**Alternatives considered:** Browser calls the runtime directly with a token embedded in the page (token leakage, CORS, multiple config sources); build a separate BFF service (unnecessary - Express already fronts the app).

### 6. Env-gated, disabled when `OPENCONNECTOR_BASE_URL` is unset

**Choice:** Read `OPENCONNECTOR_BASE_URL`, `OPENCONNECTOR_RUNTIME_TOKEN`, `OPENCONNECTOR_ADMIN_TOKEN` from env (`.env` via `dotenv/config`). If `OPENCONNECTOR_BASE_URL` is unset, log a notice, skip MCP registration and endpoint mounting behind an `openConnectorEnabled` flag, and start exactly as today.

**Why:** Directly mirrors the LiteLLM provider pattern (`litellmEnabled`), so the feature is opt-in and zero-impact for users who do not run an OpenConnector runtime.

**Alternatives considered:** Always-on with a hard default of `http://localhost:3000` (would cause noisy connection errors and spurious MCP failures for users without the runtime).

### 7. Web panel as a third view, vanilla JS, REST-only in v1

**Choice:** Add an "OpenConnector" panel to `public/index.html` toggled alongside Chat and Knowledge (a header button flips views). `public/app.js` gains handlers that call `/api/openconnector/*` and render: a health/enabled status row, a providers/actions browser with search, an action inspector (schema + agent guide), a connections manager (list, add API-key, remove), and an action-execute debug box. `public/style.css` gains styles matching the existing aesthetic. No new WebSocket events in v1 - operations are request/response; the panel fetches health when opened.

**Why:** Matches the project's vanilla-JS, no-build-step frontend convention and the knowledge-panel toggle pattern. Action execution is a single REST round-trip, so streaming is not needed for v1.

**Alternatives considered:** All-WebSocket for the panel (no file uploads here; REST is simpler and conventional); SSE/WebSocket streaming of long executions (defer; show a loading state in v1).

### 8. v1 connection management: API-key + no-auth; OAuth started but completed on the runtime

**Choice:** v1 supports listing connections, adding an API-key (or no-auth) connection (`PUT /api/connections/:service`), and removing one. OAuth is supported only as "store client config + start authorization" (`PUT /api/oauth/configs/:service`, `POST /api/oauth/authorizations`) which returns the `authorizationUrl` for the user to open; the callback completes on the runtime's `/oauth/callback`.

**Why:** API-key connections (e.g. GitHub PAT) and no-auth Actions (e.g. Hacker News) cover the most common debugging path with no redirect plumbing. OAuth's redirect URI is bound to the runtime origin (`OOMOL_CONNECT_ORIGIN`), so completing it inside pi-web-chat would require proxying the callback - a v2 concern.

**Alternatives considered:** Full in-browser OAuth with a proxied `/oauth/callback` on pi-web-chat (correctness risk around redirect URI mismatch and token exchange; defer to v2); OAuth-only (excludes the simplest providers).

### 9. No pi-web-chat-side persistence for this feature

**Choice:** `open-connector.js` holds only the in-memory config (base URL + tokens) read at startup. All durable state - connections, credentials, runs, OAuth configs - lives in the OpenConnector runtime.

**Why:** The runtime is the system of record for connector state; mirroring it locally would duplicate state, risk drift, and add a persistence layer for no gain. This is a notable simplification versus the knowledge-collection feature (which persists its own PageIndex store) - appropriate because here the state already has a home.

**Alternatives considered:** Cache the catalog/actions locally (stale data, invalidation complexity - the runtime is local and fast enough to call live).

## Risks / Trade-offs

- **External runtime must be running** -> The feature is useless without a reachable OpenConnector runtime. Mitigation: env-gating (disabled entirely when `OPENCONNECTOR_BASE_URL` is unset); a `GET /api/openconnector/health` check the UI polls when the panel opens; clear "runtime unreachable / module disabled" states instead of silent failures.
- **MCP SDK transport vs. stateless `POST /mcp`** -> OpenConnector's `/mcp` is stateless JSON-RPC and "does not keep `GET` SSE streams open"; the MCP SDK's `StreamableHTTPClientTransport` may expect an SSE stream and fail the handshake. Mitigation: confirm at apply by connecting and listing tools; if it fails, fall back to registering the four OpenConnector tools as pi `customTools` that POST JSON-RPC to `/mcp` (or call `/v1` equivalents) via `fetch`, bypassing `mcp-bridge` for OpenConnector only. Either way the agent gets the same four tools.
- **Runtime API shape drift** -> Exact field names of `/v1/providers`, `/v1/actions`, `/api/connections` responses are inferred from the docs and must be confirmed against a live runtime. Mitigation: isolate all runtime calls behind `open-connector.js` helpers that return normalized shapes; verify against `http://localhost:3000` during apply and adjust the mapping, not the call sites.
- **Token security** -> A leaked admin token grants connection/credential management. Mitigation: tokens live only in server env, never in responses or the page; `GET /api/openconnector/config` returns only `{ enabled, baseUrl }`; the proxy rejects attempts to override tokens via request headers.
- **Action execution latency / cost** -> Executing an Action calls the provider through the runtime and may be slow or metered. Mitigation: UI shows a loading state and surfaces errors from the runtime envelope; the runtime's own `OOMOL_CONNECT_ALLOWED_ACTIONS` policy and call timeouts bound what can run.
- **Large catalog** -> 1,000+ providers / 10,000+ Actions. Mitigation: never load the full list - use server-side search (`/v1/actions/search?q=`) and per-service listings (`/v1/actions?service=`); paginate/truncate in the UI.
- **Two-token model confusion** -> Runtime token (for `/v1`+`/mcp`) vs. admin token (for `/api`) can be confused. Mitigation: `open-connector.js` picks the correct token per endpoint family automatically; both are optional and the runtime works without tokens when not configured (local single-user).
- **Agent tool name collisions** -> OpenConnector MCP tools register as `mcp__open-connector__<tool>` (the `mcp-bridge` naming scheme), avoiding collisions with built-in tools. Mitigation: use a stable server name (`open-connector`) and confirm the allowlist includes the four names at startup.

## Migration Plan

- **Deploy:** Additive and env-gated - no data migration, no schema change. Set `OPENCONNECTOR_BASE_URL` (and optionally the two tokens) in `.env`, ensure a runtime is reachable, restart pi-web-chat. The `mcp-bridge.js` refactor is backward-compatible (`connectMcpServers(path)` behavior unchanged).
- **Rollback:** Unset the `OPENCONNECTOR_*` env vars (or remove the module import + endpoints) and restart; the server reverts to today's behavior. No persisted state to clean up.
- **Prerequisite setup (documented, not automated):** Run an OpenConnector runtime once (e.g. `docker compose up` from its repo) and connect at least one provider (API key) so the panel and agent have something to exercise.

## Open Questions

- ~~Exact response field names for `/v1/providers`, `/v1/actions`, and `/api/connections`~~ - **Resolved at apply:** response shapes vary by surface. `/v1/*` returns the uniform envelope `{ success, message, data, meta }` (e.g. `/v1/actions?service=github` -> `data` is the action array, each action carrying `id`, `service`, `name`, `description`, `requiredScopes`, `inputSchema`). The admin `/api/*` surface does **not** use the envelope: `/api/connections` and `/api/providers` return bare arrays, and `/api/runs` returns `{ items: [...] }`. `open-connector.js` returns whatever the runtime returns; the UI normalizers (`extractOcActions`, `extractOcConnections`) handle both envelope and bare shapes via `env.data ?? env`.
- ~~Whether the MCP SDK's `StreamableHTTPClientTransport` completes the handshake against OpenConnector's stateless `POST /mcp`~~ - **Resolved at apply:** it does. The boot log shows `[mcp] Connected "open-connector": 4 tool(s)` and the four tools register as `mcp__open-connector__list_apps / search_actions / get_action_guide / execute_action`. The SDK sends `Accept: application/json, text/event-stream` (which the runtime requires); the `fetch`-based custom-tools fallback (Decision 4) was not needed.
- Whether to surface OAuth client-config + start-authorization in the v1 UI or defer all OAuth to the runtime console (lean: include start-authorization since it is one call and returns a URL; revisit if the UX is confusing without a completed-callback indicator).

## Implementation Notes (discovered during apply)

- **`DELETE /api/connections/:service` requires a JSON body.** The runtime returns `400 "Request body must be valid JSON"` for a bodyless DELETE. `deleteConnection` now sends `body: {}`. (Verified: `DELETE /connections/github` -> `200 {"service":"github","connectionName":"default","configured":false}`.)
- **The runtime verifies credentials on `PUT /api/connections/:service`.** A `github` PUT with a dummy API key is rejected with `{"error":{"code":"credential_verification_failed","message":"Bad credentials"}}` and is **not** stored. Good UX (bad keys can't be saved) but it means the 6.4 "successful `github.get_current_user`" step needs a real GitHub PAT supplied by the user; the full add/list/remove/execute flow is otherwise validated.
- **Node `fetch` ignores `http_proxy`/`https_proxy` env vars.** The apply host has `http_proxy=http://127.0.0.1:7892` set (with `no_proxy=localhost,127.0.0.1,::1`, which excludes the LAN runtime host). `curl` honors the proxy and fails to reach a LAN runtime; Node's global `fetch` (used by `server.js` and the MCP SDK) goes direct and reaches it. No proxy handling is needed in `open-connector.js`; for manual probing use `curl --noproxy '*'`.
- **Execute error surfacing works end-to-end.** Running an action with no configured connection returns the runtime's envelope gracefully: `{"success":false,"message":"Configure github credentials first.","data":{"status":401},...}` - the proxy forwards it and the UI renders the message.
- **Agent-side MCP call verified.** Driving a chat turn over WebSocket: the pi-agent invoked `mcp__open-connector__execute_action({ actionId: "hackernews.get_top_stories", input: {} })`, received real Hacker News story IDs (`isError: false`), and streamed them back - confirming the full chat -> agent -> mcp-bridge -> runtime -> provider chain.
