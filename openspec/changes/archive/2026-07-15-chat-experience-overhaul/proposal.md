## Why

The chat experience defaults to a Volces model and treats past chats as read-only
archives: the live agent never resumes a previous conversation, the session list is
buried inside a History tab, documents can only be added through dedicated forms,
and skills are only discoverable via the input placeholder text. This change makes
LiteLLM the default chat model and reorganizes the UI around a chat-first,
multi-session workflow with frictionless document ingestion and in-input slash
commands - bringing the app closer to its "openclaw-like" assistant target.

## What Changes

- **LiteLLM becomes the default chat model.** The agent session starts on a LiteLLM
  model when LiteLLM is configured, overridable via a new `DEFAULT_MODEL` env var,
  falling back to Volces when LiteLLM is disabled. Today no default is set and the
  session lands on a Volces model.
- **LiteLLM management entry moves into the left nav.** The LiteLLM management-UI
  link moves out of the sidebar footer into the left navigation list as a dedicated
  entry that opens the proxy's management UI in a new tab.
- **Slash-command autocomplete in the chat input.** Typing `/` in the chat input
  opens a filtered popup of available `/skill:` commands; arrow-keys + Enter insert
  the command into the input. Today skills are only hinted in the placeholder.
- **Drag-and-drop & paste document ingestion.** Dropping files (PDF / Markdown /
  text) anywhere on the page, or pasting text/URLs from the clipboard, automatically
  ingests them into the document collection (reusing the existing LlamaIndex
  pipeline) with live `documents_status` feedback - no need to open the Documents
  tab. The existing Documents-tab forms remain available.
- **Chat list moves into the left nav.** The list of saved chat sessions moves out
  of the History tab into the left sidebar, visible alongside the nav tabs, with a
  "+ New chat" action.
- **Switch & resume chats.** Selecting a session in the left nav makes it the active
  chat: its message history is loaded into the chat view and replayed into the
  agent's context so the conversation truly continues, and new turns append to that
  session. This replaces the current "one shared agent session, no resume" model and
  is implemented on top of the pi SDK's own persistent `SessionManager` (JSONL
  sessions with resume/branching).

## Capabilities

### New Capabilities

(none - all changes extend existing capabilities)

### Modified Capabilities

- `model-selection`: Add a default-model resolution requirement. The session SHALL
  start on a LiteLLM model when LiteLLM is configured, honoring a `DEFAULT_MODEL`
  env override, and fall back to a Volces model when LiteLLM is disabled.
- `app-navigation`: The left sidebar SHALL host the chat-session list (with a
  "+ New chat" action) and a LiteLLM nav entry that opens the management UI. The
  standalone "Chat History" tab SHALL be removed; its function moves into the
  sidebar.
- `chat-history`: Sessions SHALL become switchable and resumable. Selecting a
  session SHALL load its history into the live agent (so new turns continue it) and
  new turns SHALL append to the selected session. Persistence SHALL move to the pi
  SDK's persistent `SessionManager` (replacing the app-managed read-only JSON store
  and the "no resume" behavior). Listing/viewing endpoints SHALL be backed by SDK
  sessions.
- `skill-invocation`: Add a slash-command autocomplete menu in the chat input:
  typing `/` SHALL surface a filtered list of available `/skill:` commands that can
  be inserted via keyboard.
- `document-management`: Add site-wide drag-and-drop and clipboard-paste ingestion
  that auto-saves dropped files and pasted text/URLs into the document collection
  via the existing ingestion pipeline, with live status feedback.

## Impact

- **Code**:
  - `server.js` - resolve and pass a default `model` to `createAgentSession`; switch
    from `SessionManager.inMemory()` to a persistent `SessionManager` over a
    configured sessions directory; add WS handlers for listing/switching/creating
    sessions and for loading a session's messages into the agent; expose LiteLLM
    nav config.
  - `chat-history.js` - adapt to (or wrap) the SDK session store: list/get/create/
    switch sessions via the SDK `SessionManager`; remove manual `appendMessage`
    persistence (the SDK persists on `message_end`). Existing `chat-history-store/`
    JSON sessions are imported best-effort into the SDK session dir on first run.
  - `public/index.html` + `public/app.js` + `public/style.css` - sidebar session
    list + "+ New chat"; LiteLLM nav entry; slash autocomplete popup; site-wide
    drag-drop and paste handlers that call the existing `/api/documents` endpoint.
  - `documents.js` - no core change; drag/paste reuse the existing `addDocument`
    entrypoint (file buffer / text / url).
- **APIs / WS protocol**: New WS messages for session list/switch/new and for
  replaying a loaded session's messages to the client (e.g. `sessions`, `switch_session`,
  `session_loaded`). The existing REST `/api/chat-history/sessions*` endpoints remain
  but are backed by SDK sessions.
- **Dependencies**: No new npm dependencies; reuses the pi SDK, LlamaIndex.TS, and
  multer.
- **Breaking**: The standalone History tab is removed (its function moves to the
  sidebar). The single-shared-agent-session assumption changes to per-session
  switching/resume. The on-disk session format changes from app JSON to SDK JSONL
  (existing sessions are imported best-effort).
- **Graceful degradation**: LiteLLM-disabled deployments keep working via the Volces
  fallback. If the SDK's runtime session-switch proves unable to cleanly reload
  agent context, a fallback re-creates the session pointed at the chosen session
  file (see design.md). Drag/paste degrades to the existing Documents-tab forms.
