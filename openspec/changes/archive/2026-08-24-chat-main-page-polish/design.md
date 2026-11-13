# Design — chat-main-page-polish

## Context

The current `ChatPage` (`<Chat />` + `<Composer />`) is functional but uninviting. The empty state shows a single line of muted text; the in-session state has no header. Users have to look at the sidebar to see the active model/agent, can't rename a session, and the `/skill:foo` and `/model` commands require memorization.

This change makes the chat page a first-class surface: a welcome state for new/empty sessions, a header for in-session (with editable title + status strip), and a slash-command picker in the composer. The rename action adds two small WS messages (`rename_session` client → server; `session_renamed` server → client broadcast) and a `PATCH /api/chat-history/sessions/:id` REST route that already exists conceptually in `chat-history.js` but is not exposed.

## Goals / Non-Goals

**Goals**
- Welcome state with greeting + 4 suggested prompts + recent chats.
- Session header with editable title (Enter/Esc), model/agent status, connection dot.
- Slash-command picker in the composer (built-in commands + skills, filterable, keyboard-navigable).
- Backend support for title rename (WS + REST), broadcast to all clients.

**Non-Goals**
- Markdown attachments in the welcome prompt cards.
- Per-message context menu (copy, regenerate, etc.) — separate change.
- Auto-generated titles from the first user message — v2.
- Multi-line composer, voice input, image attachments via the picker — out of scope.

## Decisions

### D1: Welcome state lives in the chat page, not the sidebar

The welcome state is a primary page surface (a "what should I do?" affordance), not a sidebar widget. It renders inside `<ChatPage />` when `turns.length === 0` and is mutually exclusive with the message log + header. The recent-chats list reuses the sidebar's `sessions[]` store — no separate fetch.

### D2: Suggested prompts are hard-coded for v1, with a hook for config

Four hard-coded cards (write code / analyze data / summarize a document / research a topic) ship in v1. The component accepts a `prompts?: { title, prompt, icon }[]` prop so a future change can read them from `agents.json` or a dedicated `welcome-prompts.json` without touching this component.

### D3: Editable title uses local state + 300ms debounce

Click on the title → input field appears. Each keystroke updates local state. A 300ms debounce fires the WS `rename_session` (and optimistic update). Enter commits immediately (no wait). Escape cancels and reverts. The broadcast `session_renamed` event reconciles all clients.

The 300ms debounce is short enough to feel instant and long enough to avoid spamming WS on rapid typing. Streaming responses don't conflict — the title is local state, debounced, and the WS is fire-and-forget for the sender.

### D4: Slash picker is a popover, not a sheet

A small popover anchored to the composer's caret position (or just below the input if caret-tracking is too complex for v1) is sufficient. The popover renders a list with sections (Commands / Skills), filter input, and keyboard nav. We use the existing dialog primitive as a base; a `SlashCommandPicker` component owns the filtering and key handling.

Alternatives considered:
- **Cmd-K palette** — rejected: discoverability problem; slash matches existing `/skill:` syntax.
- **Inline list within the composer** — rejected: composer is single-line; popover is the standard pattern.

### D5: Built-in commands are listed alongside skills

The picker shows a "Commands" section (`/clear`, `/model`, future additions) and a "Skills" section. The source of truth for built-ins is a constant in the chat-commands module; skills come from the WS `skills` event. Both sections filter by the typed substring.

### D6: Rename WS message is `rename_session`, broadcast is `session_renamed`

Two new WS messages:
- **Client → server**: `{ type: "rename_session", id, title }`. The server validates, updates both stores, and broadcasts the response event.
- **Server → client**: `{ type: "session_renamed", id, title }`. The store updates the matching session's title; the sidebar row reflects the new title.

Both WS and REST (`PATCH /api/chat-history/sessions/:id`) produce the same server-side effect. The WS path is for in-session rename from the chat header; the REST path is for the (future) sidebar context menu Rename action.

### D7: Header is sticky but not floating

The session header sticks to the top of the chat area (`position: sticky; top: 0`) and does not float over the message log on scroll. The status strip is a single line of muted text; the editable title is a `<button>` that becomes an `<input>` on click.

## Risks / Trade-offs

- **Race between rename and streaming response** → Mitigation: the rename is local state, debounced, and independent of the streaming reducer. The WS handler doesn't touch `turns[]`.
- **Suggested prompts feel generic** → Mitigation: hook for config-driven prompts in v2; v1 ships with sensible defaults.
- **Slash picker keyboard conflicts with browser shortcuts** → Mitigation: the popover only listens while open; Escape closes it; other keys bubble to the composer.
- **Title PATCH is REST-only initially, then WS too** → accepted: the REST path is exposed first (more discoverable for testing); the WS path is added when the header's edit-on-Enter is wired.
- **Server validation: title length** → Mitigation: 1–200 characters, non-empty after trim, no control characters. 400 on violation with a clear error.

## Migration Plan

Single deployment. The WS additions are additive — old clients ignore `session_renamed` (it's a no-op in their store). The PATCH endpoint is additive. The welcome state is purely UI; users on the old version see no difference.

Rollback: revert the change; nothing destructive.

## Open Questions

- Should the slash picker also list MCP tool names (so users can invoke tools by `/tool:name`)? → **Decision**: out of scope; tools are auto-allowed by dsh and don't need manual invocation in this UX. If a future change adds a tool-picker, this is the place.
- Should the welcome state be dismissed once a session is loaded, or persist alongside the log? → **Decision**: dismissed; the welcome is a "no turns" affordance only. Once a session loads, the header takes over.
- Should recent chats be 5 (per the spec) or 3 (less clutter)? → **Decision**: 5 per the spec. The list is scrollable within the welcome card; if it grows we can cap at 5 + "View all" link.
