## MODIFIED Requirements

### Requirement: Dual-source configuration with cloud precedence

The catalog SHALL merge five optional sources: a local `agents.json` file (sibling of `mcp.json`, gitignored), a cloud JSON document fetched from `AGENTS_CONFIG_URL` (same schema, top-level `agents` and `apps` arrays), agent entries from the configured mcp-gateway-registry (`GET /api/agents`, using the market registry env vars), agent entries from packs installed in the cell (openspec: pack-installation), and agent entries from the cell's user-defined presets (openspec: custom-presets). Registry agent entries SHALL be adapted to `agent-remote` entries in `link` mode (external URL) unless the registry entry declares an OpenAI-compatible endpoint, in which case `chat` mode applies with `baseUrl` and `model` mapped and the key resolved from an env var reference. Registry group membership SHALL map to the catalog entry's `roles` (no groups ⇒ visible to everyone). Pack-sourced entries SHALL be `agent-remote` `chat` entries carrying the pack's display fields and persona, with no endpoint or credential fields, and follow the same local persona-preset serving as other `chat` entries; the client-facing payload for pack-sourced entries SHALL additionally carry their `packId`, so picker surfaces can mark them as focused roles (openspec: pack-agent-scoping). Custom-preset entries SHALL be persona-only `chat` entries carrying their display fields and a `customPreset` marker with a resource summary, following the same local persona-preset serving and focus marking. On `id` collision the later source SHALL win, in the order built-in → registry → packs → user presets → `agents.json` → cloud: local overrides remote, and the cloud remains the live control plane even for ids first defined elsewhere. When the registry or cloud fetch fails, the server SHALL keep serving the last successfully fetched entries and log a warning; pack-sourced and custom-preset entries are local state and need no fetch.

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

### Requirement: Catalog chat agents are served with local persona presets

Every `chat`-mode `agent-remote` catalog entry SHALL be served by the local runtime through a generated agent preset: the deployment SHALL compose one preset per entry from the shipped `standard` agent-plane composition, replacing only the persona row's text with a persona derived from the entry (its `persona` field when present, else its `name`/`description`/`tags`), and SHALL write it into the preset roster's user root so the existing roster/picker/switch machinery applies it. For pack-sourced and custom-preset entries the derived persona SHALL append a focus note stating that the role's tools and skills focus on its own resource set (openspec: pack-agent-scoping, custom-presets), so the role answers requests outside its resource set honestly instead of inventing results. Generated presets SHALL carry a marker file so hand-authored user presets are never overwritten or pruned, SHALL be pruned when their entry leaves the catalog, SHALL NOT shadow a shipped preset id, and SHALL be regenerated (with an idle-runtime restart) whenever the merged catalog changes. An entry MAY declare `local: false` to stay a remote service instead: it gets no preset and its turns fork as before. The persisted agent-preset preference SHALL be validated against the presets the deployment can actually mount before the runtime spawns, falling back to the deployment default so a stale id can never fail session creation.

#### Scenario: A pack agent keeps the platform's capabilities

- **WHEN** the user selects a vertical-pack agent and asks a question in its domain
- **THEN** the turn runs on the local runtime with the pack's persona and the pack's skills and MCP tools plus the deployment baseline available (openspec: pack-agent-scoping), with the session's prior turns in context

#### Scenario: Selecting the agent is a preset switch

- **WHEN** the user selects a locally-served catalog agent while the runtime is idle
- **THEN** the runtime restarts with that preset (the same path as a model or preset switch), `agent_changed` lands after the switch, and the session header names the agent; a switch requested while a turn streams is rejected

#### Scenario: Switching back to the built-in agent

- **WHEN** the user selects the built-in `local` agent
- **THEN** the deployment's own persisted preset is restored, dropping the pack persona and its focused resource set

#### Scenario: Departed entry leaves no broken selection

- **WHEN** a catalog entry that had a generated preset disappears from the catalog
- **THEN** its preset directory is pruned, the selection falls back to the built-in agent, and clients are told through `agent_changed`
