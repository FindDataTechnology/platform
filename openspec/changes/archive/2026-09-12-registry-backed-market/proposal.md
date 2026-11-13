## Why

The extension market is a pair of static local JSON files (`market-catalog.json`, `market-catalog-skills.json`) cached in-process for the server's lifetime — adding or withdrawing an entry requires a redeploy. The `extension-marketplace` spec already promises "optionally fetched from a remote registry URL if configured", but no implementation exists (spec drift). Meanwhile the operator runs a self-hosted [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry) with Logto-backed user groups holding curated MCP servers, skills, and A2A agents; paas users authenticated through forward-auth (Logto) should see exactly the assets their groups grant, without the paas operator re-authoring catalogs.

## What Changes

- **Registry as a remote market source**: a new server-side adapter fetches MCP servers (`GET /api/servers`) and skills (`GET /api/skills`) from the registry using a service token, and merges them with the bundled JSON catalog (bundled entries win on name collision, since they are curated for this deployment).
- **Group-scoped market visibility**: `GET /api/extensions/market` filters registry-sourced entries by the requesting user's forward-auth groups (entry group metadata ∩ `user.groups`); bundled entries remain visible to everyone. When auth is off, registry entries without group metadata are shown (parity with agent-catalog's role rules).
- **Registry MCP entries install via the gateway URL**: each registry MCP entry maps to a `configTemplate` of `{ url: <gateway endpoint>, headers: { Authorization: "Bearer <your_token>" } }`, so the existing `requiresConfig` derivation marks them "needs config" and the existing setup-form/install path works unchanged.
- **Registry skills install with lazy content fetch**: the market lists skill metadata only; at install time the server fetches `GET /api/skills/{path}/content` and materializes it through the existing custom-skill path (DB row + SKILL.md hot-load).
- **Agents from the registry**: registry agents (`GET /api/agents`) merge into the agent catalog as `agent-remote` entries (link-mode by default), with registry group membership mapped to catalog `roles` so existing role-based visibility applies.
- **Cache + refresh model**: the merged market catalog is cached with a short TTL and refreshed in the background by the service token (no user token involved), broadcasting `market_changed` on change; filtering happens per-request against cached group metadata.
- **Out of scope (explicitly)**: per-user agent sessions, per-user MCP credential injection (OBO / user-token pass-through to the gateway), and Logto custom-claims configuration (deployment concern). The runtime remains a single team-shared agent; visibility is store-level only.

## Capabilities

### New Capabilities

(none — all behavior lands in existing capabilities)

### Modified Capabilities

- `extension-marketplace`: catalog sourcing gains a remote registry adapter (service-token fetch, TTL cache, bundled-wins merge) and the market endpoint gains per-user group visibility; skill installs from registry entries fetch content lazily at install time.
- `agent-catalog`: gains a registry source merged alongside `agents.json` + `AGENTS_CONFIG_URL`, mapping registry group membership to `roles`.

## Impact

- **Server**: `extension-store.js` (dual-source merge + cache), new registry adapter module, `server/routes/extensions.js` (`/api/extensions/market` becomes user-aware), `catalog.js` (third source), WS `market_changed` broadcast.
- **Config**: new env vars — `MARKET_REGISTRY_URL`, `MARKET_REGISTRY_TOKEN` (service token), `MARKET_REGISTRY_TTL_SECS` (optional). Unset URL ⇒ behavior identical to today (bundled catalog only).
- **Web**: market cards may show a source/registry badge; no flow changes (install path unchanged).
- **External dependency**: the self-hosted mcp-gateway-registry API (`/api/servers`, `/api/skills`, `/api/skills/{path}/content`, `/api/agents`); unavailability degrades to the bundled catalog with a warning (last-good cache, mirroring agent-catalog's cloud-outage rule).

