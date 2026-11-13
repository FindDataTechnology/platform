## Purpose

Defines the WeChat mini-program thin client: how it carries the core chat
experience (streaming chat, session history, model/agent selection, attachment
upload) over the existing WebSocket and REST contracts, and how it behaves
under mini-program lifecycle constraints (backgrounding kills sockets; no DOM
means degraded rendering).

## ADDED Requirements

### Requirement: The mini-program client runs a chat turn over the existing WS contract

The mini-program client SHALL connect to the platform over WSS and use the
same JSON message protocol as the web client (`prompt` in; `user`,
`agent_start`, `text`, `thinking`, `tool_start`/`update`/`end`, `skill_use`,
`done`, `error` out). Streaming assistant text SHALL appear incrementally as
chunks arrive. A failed or errored turn SHALL surface the error to the user
and leave the composer usable.

#### Scenario: a full turn streams end to end

- **WHEN** the user sends a prompt and the assistant streams text chunks followed by `done`
- **THEN** the user turn and the incrementally-rendered assistant turn are visible in order, and the composer re-enables on `done`

#### Scenario: server reports an error mid-turn

- **WHEN** an `error` message arrives during a turn
- **THEN** the client shows the error in the conversation, stops the streaming state, and does not leave the UI stuck

### Requirement: Assistant messages render with degraded-but-defined markdown

While a turn is streaming, assistant text SHALL render as plain text (no
markdown parsing of partial content). After the turn completes, the final
assistant message SHALL render as markdown (headings, lists, links, tables,
inline code, fenced code blocks). Fenced code blocks SHALL render as monospace
blocks without syntax highlighting. Markdown links SHALL be tappable and open
through the mini program's navigation mechanism. Malformed markdown SHALL
never crash the message list.

#### Scenario: streaming shows plain text, completion renders markdown

- **WHEN** an assistant turn streams `# Hea` then `ding\n\n- item` and completes
- **THEN** during streaming the raw text is shown as-is, and after `done` the message renders a heading and a bullet list

#### Scenario: an echarts fence renders as a chart or degrades

- **WHEN** a completed assistant message contains a fenced `echarts` block
- **THEN** the client renders it as an interactive canvas chart, or when chart rendering fails, shows the block as an ordinary code block without surfacing an error

### Requirement: Session history is browsable

The client SHALL list past chat sessions with title and recency, and opening
one SHALL display its persisted messages read-only. Session metadata SHALL
come from the existing chat-history REST endpoints.

#### Scenario: opening a past session

- **WHEN** the user opens a listed session
- **THEN** its full message history renders read-only, and returning to the list preserves scroll position of the list

### Requirement: Model and agent selection work and respect the streaming guard

The client SHALL offer model selection and chat-agent selection sourced from
the same `list_models` / `list_agents` protocol messages as the web client. A
switch SHALL be rejected while a turn is streaming, matching the web contract,
and the previously selected model/agent SHALL remain reported as current after
a rejected switch.

#### Scenario: switching models while idle vs streaming

- **WHEN** the user switches models while no turn is streaming
- **THEN** the selection applies and is reflected as current
- **WHEN** the user attempts a switch while a turn is streaming
- **THEN** the switch is rejected and the previous selection remains current

### Requirement: The socket survives mini-program lifecycle events

When the mini program is backgrounded, the platform MAY drop the socket. On
return to foreground, the client SHALL detect a dead socket and re-establish
it promptly, replaying the protocol's initial state queries after reconnect.
Reconnect attempts SHALL use capped exponential backoff, and the connection
state SHALL be visible to the user while disconnected.

#### Scenario: background then foreground

- **WHEN** the user backgrounds the mini program mid-conversation and returns after the socket was dropped
- **THEN** the socket is re-established without user action, state queries are replayed, and the conversation view is intact

#### Scenario: server unreachable

- **WHEN** the backend is unreachable for an extended period
- **THEN** reconnect attempts back off to at most one attempt per 30 seconds and the UI shows a disconnected state with a manual retry affordance

### Requirement: The composer supports attachments via document ingestion

The user SHALL be able to attach a file in the composer. The file SHALL be
uploaded through the platform's existing document-ingestion endpoint (the
same multipart path the web composer uses), and an ingested attachment SHALL
be referenced in the prompt as `@doc:<id>` so the assistant can read its
content. A file whose content cannot be extracted SHALL still be attachable
when the response carries a stored original (matching the web composer's
chip behavior). An upload failure SHALL surface an error without blocking
the text of the prompt.

#### Scenario: attach and send

- **WHEN** the user attaches a file and sends a prompt
- **THEN** the file is uploaded through the document-ingestion endpoint first, the prompt carries its `@doc:<id>` reference, and both the text and the attachment appear in the rendered user turn

#### Scenario: upload failure does not eat the prompt

- **WHEN** an attachment upload fails
- **THEN** an error is surfaced, the attachment is not referenced in the prompt, and the typed text remains sendable
