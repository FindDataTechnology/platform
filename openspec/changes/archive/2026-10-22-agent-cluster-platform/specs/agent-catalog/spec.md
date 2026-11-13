# agent-catalog Specification (delta)

## MODIFIED Requirements

### Requirement: Catalog entry types

The catalog SHALL accept entries of three types: `agent-local` (the built-in agent session, now backed by the dsh runtime instead of the pi session), `agent-remote` (an external agent reached over an OpenAI-compatible HTTP API or the A2A protocol, with `mode` either `chat`, `link`, or `a2a`), and `app` (a third-party bound application, with `kind` either `link` or `nango-connect`). Every entry SHALL have a unique `id`, MAY declare `roles` (a list of group names restricting visibility) and a display `name`. An `a2a`-mode entry SHALL carry the A2A route `url` of a registry gateway-proxied Agent Service. A chat-mode `agent-remote` entry sourced from an installed pack that declares `cluster` metadata SHALL additionally carry `clusterId` (the source pack id), `clusterName`, and `isDefaultAgent`, on both `GET /api/catalog` and the `agents` WebSocket message (openspec: agent-cluster-core); entries from other sources carry none of them.

#### Scenario: Built-in agent is always present

- **WHEN** the catalog is served
- **THEN** the built-in `agent-local` entry represents the dsh-backed agent session, and selecting it behaves exactly as before this change (prompts route to the dsh runtime via the bridge)

#### Scenario: Invalid entries are skipped

- **WHEN** a catalog source contains an entry with an unknown `type`, a duplicate `id`, a `chat`-mode `agent-remote` missing `baseUrl` or `model`, or an `a2a`-mode `agent-remote` missing `url`
- **THEN** the server logs a warning, drops that entry, and serves the rest of the catalog

#### Scenario: Cluster pack members carry cluster fields

- **WHEN** a pack with cluster metadata is installed and the catalog is served
- **THEN** its member entries carry `clusterId`, `clusterName`, and `isDefaultAgent`, while built-in and registry entries do not
