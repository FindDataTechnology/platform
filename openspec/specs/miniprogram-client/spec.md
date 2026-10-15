# miniprogram-client Specification

## Purpose

Defines the WeChat mini-program thin client: how it carries the core chat
experience (streaming chat, session history, model/agent selection, attachment
upload) over the existing WebSocket and REST contracts, and how it behaves
under mini-program lifecycle constraints (backgrounding kills sockets; no DOM
means degraded rendering).

## Requirements

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
blocks without syntax highlighting. Markdown links SHALL be tappable: a link
whose target resolves to a file inside the agent workspace SHALL render as a
file chip offering preview and save-to-resources (see `resource-library-ui`);
all other links SHALL keep the existing copy-to-clipboard affordance and SHALL
NOT be presented as files. Malformed markdown SHALL never crash the message
list.

#### Scenario: streaming shows plain text, completion renders markdown

- **WHEN** an assistant turn streams `# Hea` then `ding\n\n- item` and completes
- **THEN** during streaming the raw text is shown as-is, and after `done` the message renders a heading and a bullet list

#### Scenario: an echarts fence renders as a chart or degrades

- **WHEN** a completed assistant message contains a fenced `echarts` block
- **THEN** the client renders it as an interactive canvas chart, or when chart rendering fails, shows the block as an ordinary code block without surfacing an error

#### Scenario: a workspace file link renders as a chip

- **WHEN** a completed assistant message contains a markdown link to a generated workspace file
- **THEN** the link renders as a file chip with preview and save-to-resources actions

#### Scenario: an external URL keeps the clipboard behavior

- **WHEN** a completed assistant message contains a markdown link to an external URL
- **THEN** tapping it keeps the existing copy-to-clipboard affordance

### Requirement: Session history is browsable

The client SHALL list past chat sessions with title and recency from the
existing chat-history REST endpoints. Tapping a session row SHALL continue
that conversation in the live chat: the client SHALL send `switch_session`
for the row's id and land the user on the chat page, where the session's
turns render through the SAME transcript renderer as live chat. A dedicated
read-only session viewer SHALL NOT exist. Each row SHALL offer a share
affordance (the ↗ icon, consistent with the chat header): tapping it SHALL
create a share token for that session and prompt the forward-card flow, and
SHALL NOT open the session.

#### Scenario: opening a past session

- **WHEN** the user taps a session row in the history list
- **THEN** the live chat switches to that session (`switch_session` → the chat page renders its turns through the shared transcript renderer), the user lands on the chat page ready to type, and returning to the list preserves the list's scroll position

#### Scenario: the row share icon shares instead of opening

- **WHEN** the user taps a row's ↗ affordance
- **THEN** a share token is created for that session with a forward-card toast, and the session does not open

### Requirement: Model and agent selection work and respect the streaming guard

The client SHALL offer model selection and chat-agent selection sourced from
the same `list_models` / `list_agents` protocol messages as the web client.
Selection SHALL be surfaced through a single combined entry in the chat
header (agent · model) that opens a bottom selection panel; the panel SHALL
list agents and models, apply a choice immediately on tap, and be dismissible
without change via the mask or a close affordance. In an empty session the
panel SHALL also offer preset selection (broken presets excluded); once the
session has turns the preset section SHALL NOT appear. A switch SHALL be
rejected while a turn is streaming, matching the web contract, and the
previously selected model/agent SHALL remain reported as current after a
rejected switch. The combined entry SHALL reflect the currently selected
agent and model.

#### Scenario: switching models while idle vs streaming

- **WHEN** the user opens the selection panel, switches models while no turn is streaming, and dismisses the panel
- **THEN** the selection applies, is reflected in the combined header entry, and is reported as current
- **WHEN** the user attempts a switch while a turn is streaming
- **THEN** the switch is rejected and the previous selection remains current

#### Scenario: dismissing the panel changes nothing

- **WHEN** the user opens the selection panel and taps the mask (or close) without choosing
- **THEN** the panel closes and the previously selected agent/model/preset remain current

#### Scenario: presets appear only in an empty session

- **WHEN** the session has zero turns and the user opens the selection panel
- **THEN** preset choices are listed alongside agents and models
- **WHEN** the session already has turns
- **THEN** the panel offers agents and models only

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

### Requirement: The chat page header follows a three-zone layout

The chat page header SHALL present three affordances: a history entry that
opens the sessions page, the combined agent·model entry (per the selection
requirement), and a new-session action. The collapsed combined entry SHALL
show the active agent's name only; the active model SHALL be visible inside
the selection panel rather than in the collapsed label. The header SHALL NOT
contain the server-address setting; that setting SHALL be reachable from the
sessions (history) page.

#### Scenario: header renders the three zones

- **WHEN** the chat page is mounted
- **THEN** the header shows a history entry, one combined agent·model entry labeled with the active agent's name, and a new-session action, and no server-setting control

#### Scenario: the model is chosen from the panel

- **WHEN** the user opens the combined entry
- **THEN** the panel shows the active model alongside the agent and preset choices, and picking a model updates it without changing the collapsed label's agent name

#### Scenario: server address is set from the history page

- **WHEN** the user opens the sessions page and uses the server-settings entry there
- **THEN** the address can be edited and saved, and saving triggers a reconnect — the same behavior the chat-header entry had

### Requirement: The composer renders as a card with inline controls

The composer SHALL render as a single rounded card containing the text input,
any pending attachment chips, and a controls row — attach action on the left,
send/stop control on the right — inside the card. The send control SHALL do
nothing when the draft is empty and no attachment is attached, and while a
configuration switch is pending. While a turn streams, the send control SHALL
be replaced by a stop control whose activation locally finalizes the turn.
The composer's bottom padding SHALL account for the device safe-area inset so
the controls are never overlapped by the home indicator, and keyboard lift
SHALL keep the card visible above the keyboard.

#### Scenario: composer card holds input, chips, and controls together

- **WHEN** the user attaches a document and types a draft
- **THEN** the attachment chip and the text input are visible inside the same card as the attach and send controls

#### Scenario: send becomes stop while streaming

- **WHEN** a turn is streaming
- **THEN** the right-hand control is a stop control, and tapping it finalizes the turn locally and restores the send control

### Requirement: The empty-session welcome offers suggested prompts that prefill the draft

When the session has no turns, the chat page SHALL present a welcome that
showcases the product and offers quick-start paths, in this order: a
positioning line, an agent-card grid for every chat-mode agent in the current
roster (each card showing the agent's name and description, tapping it SHALL
switch to that agent without leaving the page), a general-chat quick start,
the suggested-prompt cards, and a recent-sessions strip listing the most
recent sessions from the store's session list (tapping one SHALL load it).
When the roster contains no agents beyond the built-in one, the welcome SHALL
fall back to a prompts-and-recent layout without the card grid. The welcome
SHALL also offer a link to the sessions (history) page.

For a bound (signed-in or demo) user, tapping a suggested-prompt card SHALL
prefill the draft with the prompt text; it SHALL NOT send. For an unbound
user on a non-demo deployment, tapping a suggested-prompt card SHALL enter
the demo sandbox directly, carrying that prompt into the demo draft, and
SHALL NOT send.

#### Scenario: the showcase renders from the live roster

- **WHEN** the session has no turns and the roster holds the pack agents
- **THEN** the welcome shows a positioning line, one card per chat agent (name + description), a general-chat start, the suggested prompts, and a recent-sessions strip

#### Scenario: tapping a suggested prompt prefills without sending

- **WHEN** a bound user taps a suggested-prompt card on the welcome
- **THEN** the composer draft contains that prompt text and no prompt message is sent

#### Scenario: an unbound user's prompt tap starts the demo with context

- **WHEN** an unbound user on a non-demo deployment taps a suggested-prompt card
- **THEN** the client enters the demo sandbox and the demo draft is prefilled with that prompt — no prompt is sent from the account deployment

#### Scenario: roster-empty fallback

- **WHEN** the deployment exposes only the built-in agent
- **THEN** the welcome omits the card grid and still offers the prompts and the recent-sessions strip

### Requirement: Assistant turns expose copy and regenerate actions

Every completed (non-streaming) assistant turn SHALL expose a copy action that
places the turn's text content — the concatenated plain text of its text
blocks, in order — on the clipboard and confirms with a toast. The most
recent assistant turn SHALL additionally expose a regenerate action when no
turn is streaming; activating it SHALL re-send the last user prompt as a new
appended turn, leaving prior history unmutated. Regenerate SHALL NOT appear
on a non-latest assistant turn or when no user turn precedes it.

#### Scenario: copy places the turn text on the clipboard

- **WHEN** the user taps the copy action of a completed assistant turn
- **THEN** the clipboard holds the turn's text-block content and a confirmation toast appears

#### Scenario: regenerate appends an honest new turn

- **WHEN** the user taps regenerate on the latest assistant turn while nothing is streaming
- **THEN** the last user prompt is re-sent as a new prompt and a new user+assistant turn pair is appended — the previous turns are unchanged

### Requirement: History secondary surfaces live in collapsed groups

The history page SHALL organize secondary surfaces below the session list as
collapsed-by-default groups: the user's active shares (count on the header;
expanding lists tokens with a revoke action), the resources entry (count on the
header; opening navigates to the resources page), the scheduled-task entry
(count on the header; the unread indication for unseen task output lives on this
group's header and clears by the existing seen-marking rules), and the
server/advanced settings. The session list itself SHALL remain the primary
surface above the groups. No secondary section SHALL render expanded without
a user tap.

#### Scenario: groups render collapsed with counts

- **WHEN** the history list page is shown
- **THEN** the session list renders first, followed by collapsed group headers for shares, resources, scheduled tasks, and server settings, each carrying its count where one exists

#### Scenario: unseen task output marks the group

- **WHEN** a scheduled task produced unseen output
- **THEN** the scheduled-task group header shows the unread indication until the session is viewed by the existing rules

#### Scenario: the resources group opens the resources page

- **WHEN** the user taps the resources group
- **THEN** the client navigates to the resources page

### Requirement: The new-session action answers every tap

The new-session action SHALL give feedback on every activation: starting a
fresh session SHALL confirm it (e.g. 「已开启新对话」), and activating it while
the current session is already blank SHALL say so (「已是新对话」) instead of
silently doing nothing.

#### Scenario: new session from an active conversation

- **WHEN** the user taps ＋ while a conversation with turns is open
- **THEN** a fresh session starts and a confirmation toast appears

#### Scenario: new session on the welcome state

- **WHEN** the user taps ＋ while the current session is already blank
- **THEN** a 「已是新对话」 toast appears and no duplicate session is created

### Requirement: Status and sign-in affordances occupy one quiet area

The chat page SHALL NOT stack multiple full-width banners. The unbound state
(loading required on a non-demo deployment) SHALL be presented inside the
welcome as its primary call-to-action — enter-demo first, sign-in secondary —
instead of a standalone banner. While on the demo origin, a single
lightweight notice line SHALL identify the demo environment and offer the
bind call-to-action (and plain exit) per the `mp-demo-sandbox` capability.
Connection trouble (connecting / disconnected) SHALL render as a slim top
indicator with a tap-to-retry affordance, not a full banner row; the
indicator SHALL disappear when connected. These affordances SHALL preserve
the sign-in contract: nothing navigates to the login page without a user
tap, and no authorization popup may ever appear.

While disconnected, the indicator block SHALL be self-diagnosing: it SHALL
show the server address the app is currently using, with an edit affordance
that opens the login page with its server field expanded (the field is a
real input on every base library — never an editable modal); changing the
address SHALL persist it and re-boot the runtime against the new origin. It
SHALL additionally show the transport's own failure text for the last
attempt (e.g. `request:fail url not in domain list`, `connectSocket:fail …`,
or the server's error body) verbatim, so a real-device user can tell a
domain-list block from a rejected login without guesswork. The reason text
SHALL clear on a successful connection.

#### Scenario: an unbound first-open shows the showcase with inline CTAs

- **WHEN** an unbound user opens the app on a non-demo deployment
- **THEN** the first screen is the showcase welcome carrying the demo entry as the primary action and sign-in as the secondary action — no stacked banners, no forced navigation

#### Scenario: connection trouble is a slim indicator

- **WHEN** the connection is connecting or disconnected
- **THEN** a slim indicator with retry appears at the top, naming the server address in use with an edit affordance
- **AND** when the last attempt failed, the transport's own failure text is shown beneath it
- **AND** no full-width banner row is shown

#### Scenario: editing the server address from the indicator

- **WHEN** the user taps the indicator's edit affordance while disconnected
- **THEN** the login page opens with the server field expanded and pre-filled with the current address
- **AND** saving a changed address re-boots against the new origin

#### Scenario: the demo notice is one line

- **WHEN** the client is on the demo origin
- **THEN** one notice line identifies the demo environment with the bind and exit affordances, and no other status banners are stacked above the welcome

### Requirement: The mini-program renders the question card with web parity

The mini-program chat SHALL render a pending ask as an interactive question card aligned with the web interaction: selectable options, multi-select where declared, an in-card free-text field for custom answers, and a cancel affordance. While a card is pending in the streaming turn, the mini-program composer SHALL be disabled; when another surface resolves the ask first, the card SHALL converge to the resolved summary.

#### Scenario: answering from the mini-program

- **WHEN** the user selects options or types custom text on a pending card and submits
- **THEN** the answer is sent over the shared chat transport and the card resolves

#### Scenario: cancelling from the mini-program

- **WHEN** the user activates the card's cancel affordance
- **THEN** a cancellation is sent and the card resolves without an answer

#### Scenario: composer gated while pending

- **WHEN** a question card is pending in the streaming turn
- **THEN** the mini-program composer is disabled until the ask resolves

#### Scenario: resolution from another surface

- **WHEN** the pending ask is resolved from another surface
- **THEN** the mini-program card converges to the resolved summary without error
