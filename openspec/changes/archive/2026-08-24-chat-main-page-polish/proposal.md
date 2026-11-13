# chat-main-page-polish

## Why

The current `ChatPage` is `<Chat />` + `<Composer />` with no header and a bare "no messages" empty state. First-time users land on a blank log with a hint of grey text and no guidance. Returning users with sessions have to scan the sidebar to see which model and agent are active, and there's no way to rename a session. The composer accepts `/skill:foo` but the user has to remember the syntax — there's no picker.

This change makes the chat page a first-class surface: a **welcome state** for empty/new sessions with suggested prompts and recent activity, a **session header** that shows the title (editable), the active model, and the active agent, and a **slash-command picker** in the composer.

## What Changes

- **Welcome state** when `turns.length === 0`:
  - Greeting line (i18n: "How can I help today?")
  - 4 suggested prompt cards (configurable: hard-coded v1 with a hook for `agents.json` to override later)
  - Recent sessions list (last 3–5 from `sessions[]` in the store, with a "View all" link to the sidebar list)
  - Subtle model/agent indicator at the bottom (clickable → `/models` and the agent select)
- **Session header** when there are turns:
  - Editable title (click to edit, Enter to commit, Esc to cancel). Server-side: extend the WS `session_loaded` / `sessions` payload with a `title` field and add a `rename_session` WS message + `PATCH /api/chat-history/sessions/:id` REST route.
  - Status strip: current model name · current agent name · connection status dot
  - Right-side: a small "open in sidebar" focus toggle (so users can quickly find the current session in the list)
- **Slash-command picker** in `<Composer>`:
  - When the user types `/`, show a popover listing available skills (`/skill:<name>`) and chat commands (`/model`, `/clear`, etc.)
  - Filter as the user types; arrow-key navigation; Enter to insert
  - Esc dismisses
- **Composer micro-improvements**:
  - Show file-attach count when attachments are present (the existing `chat-attachments` spec already wires the attach button; this surfaces the count)
  - Cmd/Ctrl+Enter to send (already implicit; make it explicit in the placeholder hint)
- **i18n**: add `chat.welcome.*`, `chat.header.*`, `chat.composer.slashPicker.*`, `chat.composer.attachments`.

The WS protocol gains a small `rename_session` request and the server returns a `session_renamed` event so all open clients update.

## Capabilities

### New Capabilities
- `chat-welcome-state`: the empty-state surface with greeting, suggested prompts, and recent sessions.

### Modified Capabilities
- `chat-ui-shell`: the chat page gains a header (editable title, model/agent strip) and routes the empty state to the welcome surface.
- `chat-commands`: the composer gets a slash-command picker that surfaces existing skills and chat commands.
- `chat-history`: sessions gain a `title` field; `rename_session` WS message and `PATCH /api/chat-history/sessions/:id` REST route.

## Impact

- **`web/src/pages/ChatPage.tsx`**: split into empty-state and in-session branches; mount the header; keep the message log + composer in both.
- **`web/src/components/ChatHeader.tsx`** → **new** (editable title + status strip).
- **`web/src/components/ChatWelcome.tsx`** → **new** (greeting + prompt cards + recent list).
- **`web/src/components/Composer.tsx`**: add slash-picker popover state and keyboard handlers.
- **`web/src/components/SlashCommandPicker.tsx`** → **new**.
- **`web/src/hooks/useChatStore.ts`**: add `renameSession(id, title)` (local optimistic + WS reconcile); the existing `sessions[]` field gets a `title` if the server sends one.
- **`web/src/types/ws.ts`**: add `rename_session` to `ClientMessage` and `session_renamed` to `ServerMessage`.
- **`server.js`**: new `rename_session` WS handler + `PATCH /api/chat-history/sessions/:id`; broadcast `session_renamed` to all connected clients.
- **`chat-history.js`**: extend `saveSession()` to accept a `title`; expose `setTitle(id, title)`.
- **`web/src/locales/*/common.json`**: add `chat.welcome.greeting / suggestedPrompts / recentChats / viewAll`; `chat.header.editTitle / status`; `chat.composer.slashPicker.title / noMatches`; `chat.composer.sendHint`.
- **e2e tests**: cover the welcome state (assert 4 cards), the editable title, and the slash picker (open, filter, pick).
- **Risk**: title-edit race if the user types fast while a streaming response is appending turns. The title edit is local state, debounced 300ms before commit; no conflict with streaming.

## Out of scope

- Markdown attachments in the welcome state cards.
- A "rename" entry in the right-click context menu on the session list (added in a later change; the menu from `ui-nav-restructure` only ships Delete v1).
- Auto-generated titles from the first user message (could replace the empty-title default; deferred to a v2).
