# agent-catalog

## ADDED Requirements

### Requirement: Catalog entry types

The catalog SHALL accept entries of three types: `agent-local` (the built-in pi agent session), `agent-remote` (an external agent reached over an OpenAI-compatible HTTP API, with `mode` either `chat` or `link`), and `app` (a third-party bound application, with `kind` either `link` or `nango-connect`). Every entry SHALL have a unique `id`, MAY declare `roles` (a list of group names restricting visibility) and a display `name`.

#### Scenario: Built-in agent is always present

- **WHEN** the catalog is served
- **THEN** the built-in `agent-local` entry represents the existing pi agent session, and selecting it behaves exactly as before this change

#### Scenario: Invalid entries are skipped

- **WHEN** a catalog source contains an entry with an unknown `type`, a duplicate `id`, or a `chat`-mode `agent-remote` missing `baseUrl` or `model`
- **THEN** the server logs a warning, drops that entry, and serves the rest of the catalog

### Requirement: Dual-source configuration with cloud precedence

The catalog SHALL merge two optional sources: a local `agents.json` file (sibling of `mcp.json`, gitignored) and a cloud JSON document fetched from `AGENTS_CONFIG_URL` (same schema, top-level `agents` and `apps` arrays). On `id` collision the cloud entry SHALL win. When the cloud fetch fails, the server SHALL keep serving the last successfully fetched cloud entries and log a warning.

#### Scenario: Cloud entry overrides local

- **WHEN** `agents.json` defines an entry with id `junior` and the cloud document defines an entry with the same id
- **THEN** the merged catalog contains the cloud version of `junior`

#### Scenario: Cloud outage does not clear the catalog

- **WHEN** `AGENTS_CONFIG_URL` becomes unreachable after a successful fetch
- **THEN** the catalog keeps the last good cloud entries and the server logs a warning instead of dropping them

### Requirement: Periodic refresh with live propagation

The server SHALL re-fetch the cloud document every `CATALOG_REFRESH_SECS` seconds (default 60) and on `POST /api/catalog/refresh`. When the merged catalog changes, the server SHALL broadcast a `catalog_changed` event over WebSocket; clients react by refetching `GET /api/catalog`.

#### Scenario: Cloud edit reaches connected clients

- **WHEN** an entry is added to the cloud document and the next refresh runs
- **THEN** all connected WebSocket clients receive `catalog_changed` and a subsequent `GET /api/catalog` includes the new entry

#### Scenario: Manual refresh

- **WHEN** `POST /api/catalog/refresh` is called by a user whose groups include `admin` (by any client when auth is off)
- **THEN** the cloud document is re-fetched immediately and the response returns the refreshed, redacted catalog

### Requirement: Role-based visibility

An entry with a non-empty `roles` array SHALL be included in `GET /api/catalog` only when the requesting user's groups intersect the entry's `roles`. Entries with empty or absent `roles` SHALL be visible to everyone. When authentication is off, no user groups exist, so only role-less entries are visible.

#### Scenario: Role-gated entry hidden from plain users

- **WHEN** a user with groups `["dev"]` requests the catalog and an entry declares `roles: ["admin"]`
- **THEN** that entry is absent from the response

### Requirement: Secret redaction

Client-facing catalog payloads SHALL NOT include API keys or tokens. Remote-agent entries reference secrets by `apiKeyEnv` (a server environment variable name) resolved server-side at call time; a literal `apiKey` in a source document, if used, SHALL be stripped from every client response along with the Nango secret.

#### Scenario: Catalog response carries no secrets

- **WHEN** any client calls `GET /api/catalog`
- **THEN** no entry in the response contains `apiKey`, a resolved key value, or `NANGO_SECRET_KEY`

### Requirement: Agent selection and remote chat streaming

The WebSocket protocol SHALL gain `set_agent` (client→server) and `agents` / `current_agent` / `agent_changed` (server→client), mirroring the model-selection messages. While the active agent is a `chat`-mode `agent-remote`, a `prompt` SHALL be forwarded to the entry's OpenAI-compatible `/chat/completions` endpoint with `stream: true`; SSE deltas are re-broadcast as the existing `text` events, completion as `done`, and failures as `error`. Agent switching SHALL be rejected while a prompt is streaming.

#### Scenario: Chatting with a remote agent

- **WHEN** the user selects a `chat`-mode remote agent and sends a prompt
- **THEN** streamed completions render in the chat UI through the existing `text` events and finish with `done`, with no frontend changes beyond agent selection

#### Scenario: Remote failure surfaces as error

- **WHEN** the remote endpoint returns an error or the stream aborts mid-flight
- **THEN** the client receives an `error` event and the server returns to the non-streaming state

#### Scenario: Switch blocked mid-stream

- **WHEN** a `set_agent` message arrives while a prompt is streaming
- **THEN** the switch is rejected, mirroring `set_model` behavior

### Requirement: Link agents

A `link`-mode `agent-remote` entry carries a `url`; the Agents page SHALL present it as an external link, and PAAS SHALL NOT proxy or embed it.

#### Scenario: Link agent on the page

- **WHEN** the catalog contains a `link`-mode remote agent
- **THEN** the Agents & Apps page shows it as a link that opens its `url` in a new tab

### Requirement: App entries and the Nango connect broker

`app` entries of `kind: "link"` carry a `url` opened externally. Entries of `kind: "nango-connect"` declare `nangoUrl`, `connectUiUrl`, and `apiUrl`; `POST /api/apps/:id/connect` SHALL mint a Nango connect session server-side using the server-held `NANGO_SECRET_KEY` (POST `<nangoUrl>/connect/sessions` with tags `end_user_id` / `end_user_email` / `organization_id` derived from the requesting user's email) and return the Connect UI URL with `session_token` and `apiURL` query params. The endpoint SHALL return an error when authentication is off, since there is no identity to tag.

#### Scenario: Bound-app connect flow

- **WHEN** an authenticated user triggers connect on a `nango-connect` entry
- **THEN** they are redirected to the Connect UI with a freshly minted session token whose tags carry their email, and the Nango secret never appears in any client-visible payload

#### Scenario: Broker unavailable without auth

- **WHEN** `AUTH_MODE` is off and `POST /api/apps/:id/connect` is called
- **THEN** the server responds with an error explaining the flow requires login

### Requirement: v1 shared-session ceiling

In v1 the local agent remains one shared session for all clients, remote-agent chats are broadcast to all connected clients and are not persisted into chat-history, and there is no per-user isolation of sessions or documents. This ceiling SHALL be documented rather than silently discovered.

#### Scenario: Remote chat visibility

- **WHEN** two clients are connected and one chats with a remote agent
- **THEN** both clients see the streamed `text` events, consistent with the existing shared-session broadcast model
