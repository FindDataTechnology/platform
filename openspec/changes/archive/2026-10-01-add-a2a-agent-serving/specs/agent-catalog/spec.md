## MODIFIED Requirements

### Requirement: Catalog entry types

The catalog SHALL accept entries of three types: `agent-local` (the built-in agent session, now backed by the dsh runtime instead of the pi session), `agent-remote` (an external agent reached over an OpenAI-compatible HTTP API or the A2A protocol, with `mode` either `chat`, `link`, or `a2a`), and `app` (a third-party bound application, with `kind` either `link` or `nango-connect`). Every entry SHALL have a unique `id`, MAY declare `roles` (a list of group names restricting visibility) and a display `name`. An `a2a`-mode entry SHALL carry the A2A route `url` of a registry gateway-proxied Agent Service.

#### Scenario: Built-in agent is always present

- **WHEN** the catalog is served
- **THEN** the built-in `agent-local` entry represents the dsh-backed agent session, and selecting it behaves exactly as before this change (prompts route to the dsh runtime via the bridge)

#### Scenario: Invalid entries are skipped

- **WHEN** a catalog source contains an entry with an unknown `type`, a duplicate `id`, a `chat`-mode `agent-remote` missing `baseUrl` or `model`, or an `a2a`-mode `agent-remote` missing `url`
- **THEN** the server logs a warning, drops that entry, and serves the rest of the catalog

### Requirement: Dual-source configuration with cloud precedence

The catalog SHALL merge five optional sources: a local `agents.json` file (sibling of `mcp.json`, gitignored), a cloud JSON document fetched from `AGENTS_CONFIG_URL` (same schema, top-level `agents` and `apps` arrays), agent entries from the configured mcp-gateway-registry (`GET /api/agents`, using the market registry env vars), agent entries from packs installed in the cell (openspec: pack-installation), and agent entries from the cell's user-defined presets (openspec: custom-presets). Registry agent entries SHALL be adapted to `agent-remote` entries in `link` mode (external URL) unless the registry entry declares an OpenAI-compatible endpoint, in which case `chat` mode applies with `baseUrl` and `model` mapped and the key resolved from an env var reference; a registry entry whose `supported_protocol` is `a2a` SHALL instead map to an `a2a`-mode entry whose `url` is the gateway route (`{registry}/agent/{path}/`), regardless of any external URL it carries. Registry group membership SHALL map to the catalog entry's `roles` (no groups ⇒ visible to everyone). Pack-sourced entries SHALL be `agent-remote` `chat` entries carrying the pack's display fields and persona, with no endpoint or credential fields, and follow the same local persona-preset serving as other `chat` entries; the client-facing payload for pack-sourced entries SHALL additionally carry their `packId`, so picker surfaces can mark them as focused roles (openspec: pack-agent-scoping). Custom-preset entries SHALL be persona-only `chat` entries carrying their display fields and a `customPreset` marker with a resource summary, following the same local persona-preset serving and focus marking. On `id` collision the later source SHALL win, in the order built-in → registry → packs → user presets → `agents.json` → cloud: local overrides remote, and the cloud remains the live control plane even for ids first defined elsewhere. When the registry or cloud fetch fails, the server SHALL keep serving the last successfully fetched entries and log a warning; pack-sourced and custom-preset entries are local state and need no fetch.

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

- **WHEN** the registry becomes unreachable after a successful refresh
- **THEN** the catalog keeps the last-good registry entries and the server logs a warning instead of dropping them

#### Scenario: A2A registry agents map to a2a mode

- **WHEN** the registry lists an enabled agent with `supported_protocol: "a2a"`
- **THEN** the catalog contains an `a2a`-mode entry whose `url` is the gateway route `https://mcp.finddatatech.cloud/agent/{path}/`, and no `link` entry is created for it

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

## ADDED Requirements

### Requirement: A2A agents chat over the A2A protocol

While the active agent is an `a2a`-mode `agent-remote` entry, a `prompt` SHALL be served by the remote branch: the platform SHALL act as an A2A client, forwarding the turn to the entry's route via `message/send` (or `message/stream` when the card advertises streaming), mapping streamed parts to the existing `text` events, completion to `done`, and failures to `error`. Selecting or leaving an `a2a` entry SHALL NOT switch presets or restart the shared dsh runtime, and turn history SHALL persist in the cell session as with other remote turns.

#### Scenario: Chatting with a deployed Agent Service

- **WHEN** the user selects an `a2a`-mode entry and sends a prompt
- **THEN** the reply streams into the chat UI through the existing `text` events and finishes with `done`, with no shared-runtime restart

#### Scenario: Follow-up keeps context

- **WHEN** the user sends a second prompt in the same session with an `a2a` entry active
- **THEN** the forwarded turn carries the prior conversation so the Agent Service can follow up

#### Scenario: Remote failure surfaces as error

- **WHEN** the Agent Service's route returns an error or the stream aborts mid-flight
- **THEN** the client receives an `error` event and the server returns to the non-streaming state

#### Scenario: Switching away does not touch the runtime

- **WHEN** the user switches from an `a2a` entry back to the built-in agent
- **THEN** no preset switch or runtime restart occurs for the shared dsh runtime
