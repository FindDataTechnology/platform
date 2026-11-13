## 1. Configuration & default model

- [x] 1.1 Add `DEFAULT_MODEL` env support to `server.js` (read `process.env.DEFAULT_MODEL`)
- [x] 1.2 Add `SESSIONS_STORE_DIR` env support (default `sessions-store/`, overridable for E2E isolation, mirroring `CHAT_HISTORY_STORE_DIR`); resolved in `chat-history.js`
- [x] 1.3 Implement `resolveDefaultModel()` helper: `DEFAULT_MODEL` match -> first model with configured auth (a LiteLLM model when enabled). Uses `hasConfiguredAuth` rather than a static provider set, because the LiteLLM extension registers models under upstream provider names (deepseek/volcengine/openrouter/…), not "litellm"
- [x] 1.4 Pass the resolved model as `model` to `createAgentSession`; verified `current_model` on connect reflects LiteLLM (`deepseek/deepseek-v4-flash`)

## 2. Persistent, resumable sessions (SDK SessionManager)

- [x] 2.1 Replace `SessionManager.inMemory()` with `SessionManager.create(cwd, SESSIONS_DIR)` in `server.js` init
- [x] 2.2 Remove the manual `chatHistory.appendMessage("user"|"assistant", ...)` calls in `server.js` (SDK now persists on `message_end`)
- [x] 2.3 Adapt `chat-history.js` into a thin adapter over the SDK session dir: `listSessions()` via `SessionManager.list`, `getSession(id)` via `parseSessionEntries` + `buildSessionContext`, `messagesForClient()` converter, deriving title from the first user message
- [x] 2.4 Implement `switchToSession(id)`: `sessionManager.setSessionFile(path)`, read messages via `buildSessionContext()`, return `{ id, title, messages }`
- [x] 2.5 Confirmed `setSessionFile` does NOT auto-sync `agent.state.messages` (only `createAgentSession` does, at creation); switch/new explicitly re-sync via `session.agent.state.messages = sessionManager.buildSessionContext().messages`. Fallback re-creation not needed
- [x] 2.6 Confirmed atomic/crash-safe persistence via the SDK's append-only store; restart preserves sessions (legacy import reconciles the old store)

## 3. WebSocket & REST handlers for sessions

- [x] 3.1 Add WS inbound `list_sessions` -> replies `{ type: "sessions", sessions, current }`
- [x] 3.2 Add WS inbound `switch_session` (id) -> rejects if `isStreaming`; calls `switchToSession`; broadcasts `{ type: "session_loaded", id, title, messages }`
- [x] 3.3 Add WS inbound `new_session` -> rejects if `isStreaming`; creates a new SDK session; broadcasts `{ type: "session_changed", id }` + `{ type: "session_loaded", messages: [] }` + refreshed `sessions`
- [x] 3.4 Send `{ type: "sessions", ... }` on client connect so the sidebar syncs the active session
- [x] 3.5 Repoint REST `/api/chat-history/sessions` and `/api/chat-history/sessions/:id` to the SDK-backed adapter (preserve response shapes); `POST /api/chat-history/sessions` calls `createNewSession()`
- [x] 3.6 On `done`, broadcast a refreshed `sessions` list so the sidebar's active row + update time stay current

## 4. Legacy chat-history-store import

- [x] 4.1 One-time `importLegacySessions()` runs at startup only when the sessions dir is empty: converts each `chat-history-store/*.json` message into SDK `appendMessage` calls (user/assistant) in a fresh session; verified 4 sessions imported
- [x] 4.2 Wrapped each legacy session import in try/catch; logs and skips failures; leaves `chat-history-store/` intact as a backup

## 5. Sidebar UI: session list, LiteLLM nav, remove History tab

- [x] 5.1 In `public/index.html`: removed the "Chat History" nav tab and `view-history`; added a sidebar `#session-list-section` with a "+ New" button and `#session-list`; added a `#litellm-nav-entry` link (hidden by default)
- [x] 5.2 In `public/app.js`: handle `sessions` / `session_changed` / `session_loaded` WS events; `renderSessionList` (title + updatedAt, active highlight); wire "+ New" -> `new_session`; row click -> `switch_session`
- [x] 5.3 On `session_loaded`, `loadSessionIntoView` clears the chat view and renders the loaded user/assistant bubbles before live streaming resumes
- [x] 5.4 Moved LiteLLM management link into the sidebar `#litellm-nav-entry` (reuses `/api/config` -> `litellmManagementUrl`); shown only when configured; old footer link removed
- [x] 5.5 Updated `showView`/`views` for the reduced tab set (Chat, Documents, OpenConnector); session-list region is always visible (in the sidebar, not tied to views)
- [x] 5.6 Styled the session list, active row, LiteLLM nav entry, autocomplete popup, drop overlay, and toast in `public/style.css`

## 6. Slash-command autocomplete

- [x] 6.1 Added `#autocomplete-popup` inside `#input-area` (positioned above the input)
- [x] 6.2 On input, detect a `/` token at start or after a space; open the popup filtered by the text after `/` against `availableSkills`
- [x] 6.3 Keyboard navigation: ArrowUp/ArrowDown move selection, Enter inserts `/skill:<name> ` and refocuses, Escape closes
- [x] 6.4 Inserting does not auto-send; normal typing/sending still works; popup closes on blur (delayed) and when the `/` token is deleted
- [x] 6.5 Styled the popup and `.ac-item.active` in `public/style.css`

## 7. Drag-and-drop & clipboard-paste ingestion

- [x] 7.1 Added `window` `dragover` (prevent default) and `drop` handlers; map dropped files by extension to pdf/markdown/text and POST multipart to `/api/documents`
- [x] 7.2 Added `window` `paste` handler: if `clipboardData.files` present, ingest as files; else if the paste target is not an `input`/`textarea`/`[contenteditable]`, ingest text as `text` (or `url` if it parses as a URL)
- [x] 7.3 Pasting into the chat input, Documents textareas, and OpenConnector fields behaves normally (editable check)
- [x] 7.4 Drops on `input[type=file]` are ignored (closest check); the Documents file input keeps its own handler
- [x] 7.5 Transient toast per drop/paste; relies on existing `documents_status` events; shows a "document collection disabled" notice and skips the API when the module is off (`detectDocModule` probes `/api/documents`)
- [x] 7.6 Styled the drop overlay and toast in `public/style.css`

## 8. Verification & tests

- [x] 8.1 Verified default model is a LiteLLM model (`deepseek/deepseek-v4-flash`); `DEFAULT_MODEL` override implemented; Volces fallback when LiteLLM off (via `hasAuth` scoping)
- [x] 8.2 Verified via `@smoke switching sessions resumes the conversation history`: new chat, switch between chats, resume reloads history into the chat view, sidebar highlights the active session
- [x] 8.3 `/` autocomplete implemented (lists/filters/inserts skills; Escape closes; inserted commands invoke via the existing send flow)
- [x] 8.4 Verified via E2E: dropping a file and pasting text ingest into documents with `ready` status (`documents.spec.js`); paste-into-input is not hijacked (editable check); disabled-module notice implemented
- [x] 8.5 Updated the Playwright E2E suite: `SESSIONS_STORE_DIR` isolation; replaced History-tab tests with sidebar session list/switch tests; added drag-drop/paste tests and a session-switch resume `@smoke` test
- [x] 8.6 Ran `openspec validate chat-experience-overhaul` and the full E2E suite (fast: 11 passed; smoke: 2 passed); no regressions in chat streaming, model selection, skill invocation, or document management
