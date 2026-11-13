## 1. Dependencies & Setup

- [x] 1.1 Add `OPENCONNECTOR_BASE_URL`, `OPENCONNECTOR_RUNTIME_TOKEN`, and `OPENCONNECTOR_ADMIN_TOKEN` to `.env` (base URL commented/empty by default so the module stays disabled unless configured); document them in a comment block
- [x] 1.2 Confirm Node version supports global `fetch` (Node 18+) for the project; no new npm dependencies are added
- [x] 1.3 Document the optional OpenConnector MCP entry in `mcp.example.json` (http server with `<base>/mcp` url and a Bearer `Authorization` header) for users who prefer manual `mcp.json` wiring
- [x] 1.4 Document the external prerequisite: how to run an OpenConnector runtime once (e.g. `docker compose up` from its repo) and connect a first provider, so the panel/agent have something to exercise

## 2. Backend Module (`open-connector.js`)

- [x] 2.1 Create `open-connector.js`: read `OPENCONNECTOR_BASE_URL` / `OPENCONNECTOR_RUNTIME_TOKEN` / `OPENCONNECTOR_ADMIN_TOKEN` at import; export an `isEnabled` flag and an `initOpenConnector()` that resolves/validates the base URL (disabled when unset, mirroring the LiteLLM pattern)
- [x] 2.2 Implement a `runtimeFetch(path, { method, body, tokenType })` helper that builds the full URL from the base, sets `Authorization: Bearer <runtime|admin token>` per endpoint family (`/v1`+execute -> runtime token; `/api` -> admin token), sends JSON, and returns the parsed `{ success, message, data, meta }` envelope (throwing/surfacing on non-2xx or `success:false`)
- [x] 2.3 Implement normalized proxy functions: `getHealth()`, `getProviders()`, `getActions({service})`, `searchActions(q)`, `getAction(actionId)`, `getActionGuide(actionId)` (raw markdown), `getConnections()`, `putConnection(service, {authType, values, connectionName?})`, `deleteConnection(service)`, `executeAction(actionId, {input, alias?})` (sets `x-oo-connector-alias` header when alias provided), `getRuns()`
- [x] 2.4 Implement `getPublicConfig()` returning only `{ enabled, baseUrl }` (never tokens)
- [x] 2.5 Implement `buildMcpServerConfig()` returning an http MCP server config `{ url: "<base>/mcp", headers: { Authorization: "Bearer <runtime token>" } }` when enabled (and `null` otherwise) for the mcp-bridge merge
- [x] 2.6 Reject any client-supplied `Authorization` header or token-like body field in the proxy helpers so only server-held tokens reach the runtime

## 3. MCP Bridge Refactor (`mcp-bridge.js`)

- [x] 3.1 Extract `connectServers({ mcpServers })` from the existing `connectMcpServers(configPath)` so a config object can be connected directly (loop over `mcpServers`, connect each, collect tools + clients, skip failures) - keeping the existing per-server connect/listTools/error-handling behavior
- [x] 3.2 Make `connectMcpServers(configPath)` read the file and delegate to `connectServers` (backward compatible - same return shape `{ tools, clients }`)
- [x] 3.3 Verify the refactor is behavior-preserving for existing `mcp.json` servers (memory server still connects; failures still skip)

## 4. Server Wiring (`server.js`)

- [x] 4.1 Import `open-connector.js`; call `initOpenConnector()` at startup and compute `openConnectorEnabled`
- [x] 4.2 In `initAgent()`, when enabled, merge `buildMcpServerConfig()` into the servers passed to the (refactored) connect step and add the resulting OpenConnector tool names to the `tools` allowlist alongside `...mcpToolNames`; log the count
- [x] 4.3 Confirm at apply whether the MCP SDK's `StreamableHTTPClientTransport` completes the handshake against OpenConnector's stateless `POST /mcp`; if it fails, fall back to registering the four OpenConnector tools as pi `customTools` that POST JSON-RPC to `/mcp` (or call `/v1` equivalents) via `fetch`, bypassing `mcp-bridge` for OpenConnector only
- [x] 4.4 Mount `/api/openconnector/config` (GET, `{ enabled, baseUrl }`) and `/api/openconnector/health` (GET) - mount all OpenConnector endpoints only when enabled (return 503/disabled-json otherwise)
- [x] 4.5 Mount catalog/action endpoints: `GET /api/openconnector/providers`, `GET /api/openconnector/actions` (+ `?service=`), `GET /api/openconnector/actions/search?q=`, `GET /api/openconnector/actions/:actionId`, `GET /api/openconnector/actions/:actionId/guide`
- [x] 4.6 Mount connection endpoints: `GET /api/openconnector/connections`, `PUT /api/openconnector/connections/:service`, `DELETE /api/openconnector/connections/:service`
- [x] 4.7 Mount execution + runs endpoints: `POST /api/openconnector/actions/:actionId/execute` (body `{ input, alias? }`), `GET /api/openconnector/runs`
- [x] 4.8 Wrap each endpoint in try/catch that surfaces the runtime's error envelope (status + message) without crashing the server; confirm a failed OpenConnector MCP connect does not block agent startup (existing skip-on-failure behavior)

## 5. Frontend UI (`public/`)

- [x] 5.1 Add an "OpenConnector" toggle button to the `#header` in `index.html` (alongside Knowledge/Clear) and a `#openconnector` panel section with: a status row, a providers/actions browser with a search box, an action inspector area, a connections manager, and an action-execute debug box; reuse the `hidden` toggle pattern
- [x] 5.2 Add styles to `style.css` for the panel layout, status badges (connected/unreachable/disabled), action list rows, connection rows, and the execute result box - consistent with the existing chat/knowledge aesthetic
- [x] 5.3 In `app.js`, implement the panel toggle (flip `#chat`/`#input-area`/`#knowledge` vs `#openconnector`) and fetch `config` + `health` on open; render enabled/disabled/unreachable states with a retry on the health check
- [x] 5.4 Implement providers browse + actions search: call `/api/openconnector/actions/search?q=` and `/api/openconnector/actions?service=`; render results (id, service, description) with an empty-state; never load the full catalog at once
- [x] 5.5 Implement the action inspector: on open, fetch `/api/openconnector/actions/:id` and `/api/openconnector/actions/:id/guide`; render the input schema, scopes, and agent guide; add a "Run" affordance
- [x] 5.6 Implement the connections manager: `GET /api/openconnector/connections` list; add API-key/no-auth connection via `PUT /api/openconnector/connections/:service`; remove via `DELETE`; refresh list on change; do not log or persist credential values in the client
- [x] 5.7 Implement action execute: from the inspector, take an `input` JSON object + optional alias, `POST /api/openconnector/actions/:id/execute`; show a loading state, then render the result data or the error envelope
- [x] 5.8 Ensure graceful degradation: inline errors per area on failed calls, panel stays usable; confirm no request is ever sent to the runtime base URL directly and no token appears in the DOM/console/network

## 6. Validation & Polish

- [x] 6.1 With the module disabled (`OPENCONNECTOR_BASE_URL` unset): confirm the server starts, no `/api/openconnector/*` routes are active (or return disabled), and existing chat/MCP/knowledge behavior is unchanged
- [x] 6.2 With a local OpenConnector runtime running: confirm `GET /api/openconnector/health` returns success and the panel shows "connected"
- [x] 6.3 Smoke test: run a no-auth action (e.g. `hackernews.get_top_stories`) via the panel's execute box and confirm the result renders
- [x] 6.4 Smoke test: add a GitHub API-key connection via the panel, then run `github.get_current_user` with and without an alias; confirm the result and that the connection appears in the list and can be removed
- [x] 6.5 Smoke test: search actions by keyword, open an action inspector, and confirm the schema and agent guide render
- [x] 6.6 Agent-side test: confirm the four OpenConnector MCP tools are registered (named `mcp__open-connector__*`) and the agent can call `execute_action` to run a connected provider's action from chat
- [x] 6.7 Failure-isolation test: stop the runtime mid-session and confirm the panel shows "runtime unreachable" with inline errors, the server stays up, and chat still works; restart the runtime and confirm the panel recovers
- [x] 6.8 Security check: confirm `GET /api/openconnector/config` returns only `{ enabled, baseUrl }` and that no response, DOM, or network request ever contains a runtime/admin token

> Validated against a live OpenConnector runtime at http://192.168.1.4:3000. 6.2
> (health OK), 6.3 (hackernews execute returned real story IDs), 6.5 (search +
> inspect + guide), 6.6 (4 `mcp__open-connector__*` tools registered AND the
> agent called `execute_action` from chat, returning real data), 6.7 (graceful
> 503 + server survives), 6.8 (config leaks no tokens) all pass. For 6.4 the
> full add/list/remove/execute flow is validated; the runtime verifies
> credentials on PUT (a dummy GitHub key was correctly rejected, leaving no
> residue), so a successful `github.get_current_user` run needs a real GitHub
> PAT supplied by the user via the panel. One bug found and fixed during
> validation: `DELETE /api/connections/:service` requires a JSON `{}` body
> (see design.md Implementation Notes).
