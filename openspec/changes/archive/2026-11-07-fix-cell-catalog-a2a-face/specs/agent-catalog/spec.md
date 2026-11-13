# agent-catalog — Delta

## MODIFIED Requirements

### Requirement: Dual-source configuration with cloud precedence

The catalog SHALL merge five optional sources: a local `agents.json` file (sibling of `mcp.json`, gitignored), a cloud JSON document fetched from `AGENTS_CONFIG_URL` (same schema, top-level `agents` and `apps` arrays), agent entries from the configured mcp-gateway-registry (`GET /api/agents`, using the market registry env vars), agent entries from packs installed in the cell (openspec: pack-installation), and agent entries from the cell's user-defined presets (openspec: custom-presets). Registry agent entries SHALL be adapted to `agent-remote` entries in `link` mode (external URL) unless the registry entry declares an OpenAI-compatible endpoint, in which case `chat` mode applies with `baseUrl` and `model` mapped and the key resolved from an env var reference; a registry entry whose `supported_protocol` is `a2a` SHALL instead map to an `a2a`-mode entry whose `url` is the gateway route (`{registry}/agent/{path}/`), regardless of any external URL it carries. Registry group membership SHALL map to the catalog entry's `roles` (no groups ⇒ visible to everyone). Pack-sourced entries SHALL be `agent-remote` `chat` entries carrying the pack's display fields and persona, with no endpoint or credential fields, and follow the same local persona-preset serving as other `chat` entries; the client-facing payload for pack-sourced entries SHALL additionally carry their `packId`, so picker surfaces can role-mark them (openspec: pack-agent-scoping). Custom-preset entries SHALL be persona-only `chat` entries carrying their display fields and a `customPreset` marker with a resource summary, following the same local persona-preset serving and focus marking. On `id` collision the later source SHALL win, in the order built-in → registry → packs → user presets → `agents.json` → cloud: local overrides remote, and the cloud remains the live control plane even for ids first defined elsewhere. When the registry or cloud fetch fails, the server SHALL keep serving the last successfully fetched entries and log a warning; pack-sourced and custom-preset entries are local state and need no fetch.

**The registry agents leg is source-independent**: even when the market catalog's mcp/skills species are served by the unified facet catalog projection (a facet catalog URL configured), the registry agents leg SHALL still be read from the registry agents API (same market registry env vars), so `a2a`-mode entries remain available for fleet posts, room summoning, and picker surfaces. The agents leg SHALL degrade independently of the facet projection: an agents fetch failure SHALL keep last-good agents and warn without failing the mcp/skills refresh, and vice versa.

#### Scenario: Cloud entry overrides local

- **WHEN** `agents.json` defines an entry with id `junior` and the cloud document defines the same id
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

- **WHEN** the registry becomes unreachable after a successful refresh
- **THEN** the catalog keeps the last-good registry entries and the server logs a warning instead of dropping them

#### Scenario: A2A registry agents map to a2a mode

- **WHEN** the registry lists an enabled agent with `supported_protocol: "a2a"`
- **THEN** the catalog contains an `a2a`-mode entry whose `url` is the gateway route `{registry}/agent/{path}/` (`{registry}` being the registry gateway base URL, not a hard-coded example domain), and no `link` entry is created for it

#### Scenario: Deployed role coexists with its in-cell persona

- **WHEN** a pack's role is deployed as an Agent Service and a user has also installed that pack in their cell
- **THEN** both entries appear independently — the registry-sourced `a2a` entry and the pack-sourced `chat` persona — without id collision or shadowing

#### Scenario: Pack agent appears after subscribe

- **WHEN** a user subscribes to a pack containing an agent entry and the catalog is next served
- **THEN** the pack's agent appears in `GET /api/catalog` (carrying its `packId`) and in the agent picker, running as a local persona when selected

#### Scenario: Pack agent is shadowed by the cloud and local file

- **WHEN** a subscribed pack defines an agent with id `junior` and the cloud document (or `agents.json`) also defines `junior`
- **THEN** the merged catalog contains the cloud (or local file) version of `junior`

#### Scenario: Pack agent wins over a registry entry with the same id

- **WHEN** a subscribed pack defines an agent with id `junior` and the registry also lists an agent with id `junior`
- **THEN** the merged catalog contains the pack version of `junior`

#### Scenario: Unsubscribing removes the pack entry

- **WHEN** a user unsubscribes from a pack whose agent was in the catalog
- **THEN** the pack's agent disappears from `GET /api/catalog` and the picker, and other sources' entries with other ids are unaffected

#### Scenario: Custom preset appears after creation

- **WHEN** a user creates a custom preset and the catalog is next served
- **THEN** the entry appears in `GET /api/catalog` carrying its `customPreset` marker and resource summary, badged as a focused role in the picker

#### Scenario: Custom preset is shadowed by operator and cloud sources

- **WHEN** a custom preset has id `user.junior` and `agents.json` (or the cloud document) defines an entry with the same id
- **THEN** the merged catalog contains the `agents.json` (or cloud) version, and the preset id composes full mode under the overriding entry's persona — the same shadowing semantics pack agents follow

#### Scenario: Deleting removes the custom entry

- **WHEN** a user deletes a custom preset
- **THEN** its entry disappears from `GET /api/catalog` and the picker, and its generated preset is pruned

#### Scenario: Facet-served market still carries registry agents

- **WHEN** the deployment configures a facet catalog URL (the mcp/skills species come from the facet projection) and the registry lists enabled `a2a` agents
- **THEN** the merged catalog contains those agents as `a2a`-mode entries with gateway-route urls, and fleet posts targeting them resolve alive rather than vacant

#### Scenario: Agents leg degrades independently of the facet projection

- **WHEN** the facet projection refresh succeeds but the registry agents fetch fails (unreachable or unauthorized)
- **THEN** the mcp/skills species still refresh, the catalog keeps last-good agents, and the server logs a warning — neither face is blocked by the other's failure
