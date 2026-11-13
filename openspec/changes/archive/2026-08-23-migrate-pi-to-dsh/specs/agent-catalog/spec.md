## MODIFIED Requirements

### Requirement: Catalog entry types

The catalog SHALL accept entries of three types: `agent-local` (the built-in agent session, now backed by the dsh runtime instead of the pi session), `agent-remote` (an external agent reached over an OpenAI-compatible HTTP API, with `mode` either `chat` or `link`), and `app` (a third-party bound application, with `kind` either `link` or `nango-connect`). Every entry SHALL have a unique `id`, MAY declare `roles` (a list of group names restricting visibility) and a display `name`.

#### Scenario: Built-in agent is always present

- **WHEN** the catalog is served
- **THEN** the built-in `agent-local` entry represents the dsh-backed agent session, and selecting it behaves exactly as before this change (prompts route to the dsh runtime via the bridge)

#### Scenario: Invalid entries are skipped

- **WHEN** a catalog source contains an entry with an unknown `type`, a duplicate `id`, or a `chat`-mode `agent-remote` missing `baseUrl` or `model`
- **THEN** the server logs a warning, drops that entry, and serves the rest of the catalog

### Requirement: v1 shared-session ceiling

In v1 the local agent remains one shared session for all clients — now a single shared dsh runtime subprocess, not a per-connection or per-user dsh session. Remote-agent chats are broadcast to all connected clients and are not persisted into chat-history, and there is no per-user isolation of sessions or documents. This ceiling SHALL be documented rather than silently discovered.

#### Scenario: Remote chat visibility

- **WHEN** two clients are connected and one chats with a remote agent
- **THEN** both clients see the streamed `text` events, consistent with the existing shared-session broadcast model
