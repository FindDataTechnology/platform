# agent-catalog Specification (delta)

## MODIFIED Requirements

### Requirement: Agent selection and remote chat streaming

The WebSocket protocol SHALL gain `set_agent` (client→server) and `agents` / `current_agent` / `agent_changed` (server→client), mirroring the model-selection messages.

While the active agent is a `chat`-mode `agent-remote`, the turn SHALL be served by the LOCAL runtime when the deployment has generated a persona preset for that entry (see the new requirement below) — the entry's identity becomes the session's persona and the turn keeps the local runtime's tools (MCP servers, skills) and session history. Only when no persona preset exists for the entry SHALL a `prompt` be forwarded to the entry's OpenAI-compatible `/chat/completions` endpoint with `stream: true`; that fork SHALL replay the session's mirrored turns (most recent first up to a bounded count) plus a system message naming the entry, so a remote turn is not a standalone question. In both cases SSE deltas are re-broadcast as the existing `text` events, completion as `done`, and failures as `error`. Agent switching SHALL be rejected while a prompt is streaming.

#### Scenario: Chatting with a locally-served agent

- **WHEN** the user selects a `chat`-mode remote agent the deployment serves locally and sends two prompts in one session
- **THEN** both turns run on the local runtime — the second sees the first, and tools the deployment composed (MCP servers, skills) are available — with the entry's name/description as the persona

#### Scenario: Chatting with a remote agent

- **WHEN** no persona preset exists for the selected entry and the user sends a prompt
- **THEN** streamed completions render in the chat UI through the existing `text` events and finish with `done`, with no frontend changes beyond agent selection

#### Scenario: Forked remote agent keeps the conversation

- **WHEN** the user sends a second prompt to a forked remote agent in the same session
- **THEN** the request carries the session's prior turns (bounded) so the entry can follow up on what it already said

#### Scenario: Remote failure surfaces as error

- **WHEN** the remote endpoint returns an error or the stream aborts mid-flight
- **THEN** the client receives an `error` event and the server returns to the non-streaming state

#### Scenario: Switch blocked mid-stream

- **WHEN** a `set_agent` message arrives while a prompt is streaming
- **THEN** the switch is rejected, mirroring `set_model` behavior

## ADDED Requirements

### Requirement: Catalog chat agents are served with local persona presets

Every `chat`-mode `agent-remote` catalog entry SHALL be served by the local runtime through a generated agent preset: the deployment SHALL compose one preset per entry from the shipped `standard` agent-plane composition, replacing only the persona row's text with a persona derived from the entry (its `persona` field when present, else its `name`/`description`/`tags`), and SHALL write it into the preset roster's user root so the existing roster/picker/switch machinery applies it. Generated presets SHALL carry a marker file so hand-authored user presets are never overwritten or pruned, SHALL be pruned when their entry leaves the catalog, SHALL NOT shadow a shipped preset id, and SHALL be regenerated (with an idle-runtime restart) whenever the merged catalog changes. An entry MAY declare `local: false` to stay a remote service instead: it gets no preset and its turns fork as before. The persisted agent-preset preference SHALL be validated against the presets the deployment can actually mount before the runtime spawns, falling back to the deployment default so a stale id can never fail session creation.

#### Scenario: A pack agent keeps the platform's capabilities

- **WHEN** the user selects a vertical-pack agent and asks a question in its domain
- **THEN** the turn runs on the local runtime with the pack's persona, the deployment's MCP servers and skills available, and the session's prior turns in context

#### Scenario: Selecting the agent is a preset switch

- **WHEN** the user selects a locally-served catalog agent while the runtime is idle
- **THEN** the runtime restarts with that preset (the same path as a model or preset switch), `agent_changed` lands after the switch, and the session header names the agent; a switch requested while a turn streams is rejected

#### Scenario: Switching back to the built-in agent

- **WHEN** the user selects the built-in `local` agent
- **THEN** the deployment's own persisted preset is restored, dropping the pack persona

#### Scenario: Departed entry leaves no broken selection

- **WHEN** a catalog entry that had a generated preset disappears from the catalog
- **THEN** its preset directory is pruned, the selection falls back to the built-in agent, and clients are told through `agent_changed`
