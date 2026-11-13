# add-web-search

## Why

The agent has no real-time information access: no web-search code exists anywhere in the repo, and the Knowledge panel only covers private documents. Factual, time-sensitive questions are unanswerable today. Adding search per-deployment (each customer registers a SerpAPI account and drops a key into `mcp.json`) was rejected: customers should not manage accounts, keys, or billing for a commodity capability, and uncontrolled paid API calls from demo/sandbox cells are a cost hazard. Instead the operator runs a small **search relay** service — the same "we operate one service, the software points at it" pattern as the LLM gateway — pooling multiple SerpAPI keys plus GLM search keys behind one normalized API, and every platform deployment talks to it with zero customer configuration.

## What Changes

- New first-party MCP server `server/websearch-mcp.js` (patterned after `server/cron-mcp.js`), exposing two tools to every persona preset:
  - `mcp__websearch__web_search` — calls the operator's search relay (`POST /v1/search`), which pools SerpAPI keys (rotation on 429/quota-exhausted) with GLM search as fallback, enforces per-customer token auth and daily caps, and serves identical queries from a TTL cache. The relay is an operator-side service outside this repo; this change specifies its client contract only.
  - `mcp__websearch__web_read` — fetches a page and extracts readable text **locally** in the deployment (reusing the `fetchUrlAsText` approach from `documents.js`): zero relay cost, uses the deployment's own network egress.
- The server ships enabled everywhere via a `platform.bundle.json` `mcpServers` entry — the first use of the bundled-origin seeding path (`seedStartupMcpConfigs`): dev, packaged desktop, and cloud cells all get it at startup with no customer action, visible in the Extensions page, admin-disableable.
- Configuration is `SEARCH_RELAY_URL` + `SEARCH_RELAY_TOKEN` (env in dev; supervisor-injected settings.json env in the packaged app; gateway `baseEnv` passthrough in cloud cells). When unset or unreachable, the tools degrade gracefully — they return an explicit "search unavailable" error to the agent instead of breaking the turn.
- Demo/sandbox users get full access (explicit product decision): no `requiredGroups` gating; cost is contained relay-side by cache + per-token caps.
- Non-goals: the relay service implementation/deployment and key wiring (operator work, separate deliverable); miniprogram tool-event rendering (existing gap, backlog); exposing engine choice to the model (relay normalizes to one surface); search-result UI treatment beyond the existing tool-use rendering.

## Capabilities

### New Capabilities

- `web-search`: the agent's web retrieval capability — `web_search`/`web_read` tool contracts, bundled zero-config availability across all deployment forms, relay API client contract (request/response shape, auth, error/degradation semantics), and local page-read behavior.

### Modified Capabilities

(none — mounting rides the existing bundle→extension-store→`writeMcpPatch` machinery unchanged; tool events flow through the existing tool-use-rendering and tool-discovery surfaces; no existing requirement changes.)

## Impact

- New file `server/websearch-mcp.js`; one entry added to `platform.bundle.json`; `web/src`/`miniapp` untouched.
- Page-text extraction: `documents.js` `fetchUrlAsText` is the pattern source — either extracted into a shared module or re-implemented slim in the MCP server (design decision).
- Environment surface: two new optional env vars across dev `.env`, Electron settings.json injection, and gateway `baseEnv` (verified: `buildScrubbedEnv` only scrubs `LLM_API_KEY`, so the vars reach the dsh child and its MCP subprocess).
- Operational: search calls cost money at the relay's upstream providers; the relay's cache + per-token daily caps are the cost controls (relay-side, outside this change's code).
- Tests: e2e for tool round-trips with a stubbed relay, degradation when unconfigured, and bundled seeding.
