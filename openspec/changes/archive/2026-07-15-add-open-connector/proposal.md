## Why

pi-web-chat's agent can use built-in tools and any MCP servers declared in `mcp.json`, but it has no path to the SaaS apps users already rely on (GitHub, Gmail, Notion, Slack, BigQuery, …). Connecting each means hand-writing an integration or handing provider credentials to the agent process. [OpenConnector](https://github.com/oomol-lab/open-connector) is an open-source connector gateway (an alternative to Composio) that connects 1,000+ providers once and exposes their Actions to agents through MCP, HTTP, and OpenAPI while keeping credentials inside its own runtime boundary. Integrating it lets pi-web-chat's agent call any connected provider's Actions, and gives users a web panel to browse the catalog, configure connections, and debug Actions - without forking the gateway or giving the agent raw credentials.

## What Changes

- Add a backend `open-connector.js` module that talks to a separately-run OpenConnector runtime over its HTTP API (runtime token for `/v1/*`, admin token for `/api/*`). Runtime URL and tokens come from env (`OPENCONNECTOR_BASE_URL`, `OPENCONNECTOR_RUNTIME_TOKEN`, `OPENCONNECTOR_ADMIN_TOKEN`); when the base URL is unset the module is disabled and the server starts normally - mirroring the existing LiteLLM provider pattern.
- Register the OpenConnector runtime's MCP endpoint (`<base>/mcp`) with the agent so it can call the discovery toolset (`list_apps`, `search_actions`, `get_action_guide`, `execute_action`) and therefore any connected provider's Actions. The http MCP server config is built from env and merged into the existing `mcp-bridge.js` connect step - no manual `mcp.json` edit required when env is set.
- Add REST endpoints on the existing Express server that proxy the OpenConnector runtime (keeping tokens server-side): runtime health, providers, actions list/search/inspect plus the per-action agent guide, connections list/add(API key)/remove, action execution, and recent runs, plus a safe config endpoint that exposes only the base URL and enabled state.
- Add an "OpenConnector" panel to the web UI (toggled alongside Chat and Knowledge) for browsing providers and actions, searching, inspecting action schemas/guides, managing API-key connections, and running an Action for debugging with its result.
- The OpenConnector runtime itself is a prerequisite run separately (e.g. `docker compose up` from its repo, Fly.io, Cloudflare, or OOMOL's hosted runtime); pi-web-chat does not embed or fork it. State (connections, credentials, runs) lives in the runtime; pi-web-chat is a thin management UI + agent bridge.

## Capabilities

### New Capabilities
<!-- Capabilities being introduced. Replace <name> with kebab-case identifier. Each creates specs/<name>/spec.md -->
- `open-connector`: Backend module that connects pi-web-chat to an externally-run OpenConnector runtime (configurable URL + runtime/admin tokens from env, disabled when unset), proxies its HTTP/admin API through REST endpoints (catalog, actions, connections, action execution, runs), and registers the runtime's MCP endpoint with the agent so its Actions are callable as agent tools.
- `open-connector-ui`: Browser panel for browsing the provider/action catalog, searching actions, inspecting action schemas and agent guides, managing API-key connections, and executing actions for debugging; shows runtime health and degrades gracefully when the runtime is unreachable or the module is disabled.

### Modified Capabilities
<!-- No existing specs in openspec/specs/ change at the requirement level. mcp-integration's mechanism is reused (an additional http MCP server is connected from env config); this is an implementation-level extension, captured under Impact, not a spec delta. -->

## Impact

- Dependencies: none new. Uses Node's global `fetch` (Node 18+) and the already-present Express/WS stack. The Connector SDK is intentionally not depended on (raw HTTP keeps coupling loose); documented as an alternative in design.md.
- New files: `open-connector.js` (runtime HTTP client + proxy helpers + MCP server config builder), UI additions in `public/index.html`, `public/app.js`, `public/style.css`.
- Modified files: `server.js` (import + init the module, mount `/api/openconnector/*` endpoints, merge the OpenConnector MCP server into the mcp connect step), `mcp-bridge.js` (small backward-compatible refactor: extract `connectServers(config)` so a config object can be merged with `mcp.json`), `mcp.example.json` (document the optional open-connector MCP entry), `.env` (add `OPENCONNECTOR_*` vars).
- External prerequisite: a running OpenConnector runtime reachable from the server (local Docker, Node, Fly.io, Cloudflare, or OOMOL hosted). Without it the feature is disabled and existing chat/MCP behavior is unchanged.
- Security: runtime/admin tokens stay server-side and are never sent to the browser; the web panel calls pi-web-chat's own `/api/openconnector/*` proxy. Action execution flows through the runtime's credential boundary - the agent and UI never see provider secrets.
- No breaking changes; the module is additive and gated on env config.
