## MODIFIED Requirements

### Requirement: Dual-source configuration with cloud precedence
The catalog SHALL merge four optional sources: a local `agents.json` file (sibling of `mcp.json`, gitignored), a cloud JSON document fetched from `AGENTS_CONFIG_URL` (same schema, top-level `agents` and `apps` arrays), agent entries from the configured mcp-gateway-registry (`GET /api/agents`, using the market registry env vars), and agent entries from packs installed in the cell (openspec: pack-installation). Registry agent entries SHALL be adapted to `agent-remote` entries in `link` mode (external URL) unless the registry entry declares an OpenAI-compatible endpoint, in which case `chat` mode applies with `baseUrl` and `model` mapped and the key resolved from an env var reference. Registry group membership SHALL map to the catalog entry's `roles` (no groups ⇒ visible to everyone). Pack-sourced entries SHALL be `agent-remote` `chat` entries carrying the pack's display fields and persona, with no endpoint or credential fields, and follow the same local persona-preset serving as other `chat` entries. On `id` collision the later source SHALL win, in the order built-in → registry → packs → `agents.json` → cloud: local overrides remote, and the cloud remains the live control plane even for ids first defined elsewhere. When the registry or cloud fetch fails, the server SHALL keep serving the last successfully fetched entries and log a warning; pack-sourced entries are local state and need no fetch.

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

#### Scenario: Pack agent appears after subscribe
- **WHEN** a user subscribes to a pack containing an agent entry and the catalog is next served
- **THEN** the pack's agent appears in `GET /api/catalog` and in the agent picker, running as a local persona when selected

#### Scenario: Pack agent is shadowed by the cloud and local file
- **WHEN** a subscribed pack defines an agent with id `junior` and the cloud document (or `agents.json`) also defines `junior`
- **THEN** the merged catalog contains the cloud (or local file) version of `junior`

#### Scenario: Pack agent wins over a registry entry with the same id
- **WHEN** a subscribed pack defines an agent with id `junior` and the registry also lists an agent with id `junior`
- **THEN** the merged catalog contains the pack version of `junior`

#### Scenario: Unsubscribing removes the pack entry
- **WHEN** a user unsubscribes from a pack whose agent was in the catalog
- **THEN** the pack's agent disappears from `GET /api/catalog` and the picker, and other sources' entries with other ids are unaffected
