## MODIFIED Requirements

### Requirement: Dual-source configuration with cloud precedence
The catalog SHALL merge three optional sources: a local `agents.json` file (sibling of `mcp.json`, gitignored), a cloud JSON document fetched from `AGENTS_CONFIG_URL` (same schema, top-level `agents` and `apps` arrays), and agent entries from the configured mcp-gateway-registry (`GET /api/agents`, using the market registry env vars). Registry agent entries SHALL be adapted to `agent-remote` entries in `link` mode (external URL) unless the registry entry declares an OpenAI-compatible endpoint, in which case `chat` mode applies with `baseUrl` and `model` mapped and the key resolved from an env var reference. Registry group membership SHALL map to the catalog entry's `roles` (no groups ⇒ visible to everyone). On `id` collision the later source SHALL win, in the order built-in → registry → `agents.json` → cloud: local overrides remote, and the cloud remains the live control plane even for ids first defined elsewhere. When the registry or cloud fetch fails, the server SHALL keep serving the last successfully fetched entries and log a warning.

#### Scenario: Cloud entry overrides local
- **WHEN** `agents.json` defines an entry with id `junior` and the cloud document defines an entry with the same id
- **THEN** the merged catalog contains the cloud version of `junior`

#### Scenario: Cloud outage does not clear the catalog
- **WHEN** `AGENTS_CONFIG_URL` becomes unreachable after a successful fetch
- **THEN** the catalog keeps the last good cloud entries and the server logs a warning instead of dropping them

#### Scenario: Registry entry is shadowed by any local definition
- **WHEN** the registry defines an agent with id `junior` and `agents.json` also defines `junior`
- **THEN** the merged catalog contains the `agents.json` version of `junior`
- **AND** a cloud entry with the same id still wins over both

#### Scenario: Registry groups gate visibility
- **WHEN** a registry agent belongs to registry group `team-a` and the requesting user's groups do not include `team-a`
- **THEN** the entry SHALL be mapped with `roles: ["team-a"]` and SHALL NOT appear in that user's `GET /api/catalog`

#### Scenario: Registry outage does not clear the catalog
- **WHEN** the registry becomes unreachable after a successful fetch
- **THEN** the catalog keeps the last-good registry entries and the server logs a warning instead of dropping them

### Requirement: Periodic refresh with live propagation
The server SHALL re-fetch the cloud document AND the registry agents every `CATALOG_REFRESH_SECS` seconds (default 60) and on `POST /api/catalog/refresh`. When the merged catalog changes, the server SHALL broadcast a `catalog_changed` event over WebSocket; clients react by refetching `GET /api/catalog`.

#### Scenario: Cloud edit reaches connected clients
- **WHEN** an entry is added to the cloud document and the next refresh runs
- **THEN** all connected WebSocket clients receive `catalog_changed` and a subsequent `GET /api/catalog` includes the new entry

#### Scenario: Registry agent reaches connected clients
- **WHEN** an agent is registered in the registry and the next refresh runs
- **THEN** all connected WebSocket clients receive `catalog_changed` and a subsequent `GET /api/catalog` includes the new entry for users whose groups permit it

#### Scenario: Manual refresh
- **WHEN** `POST /api/catalog/refresh` is called by a user whose groups include `admin` (by any client when auth is off)
- **THEN** the cloud document and registry agents are re-fetched immediately and the response returns the refreshed, redacted catalog
