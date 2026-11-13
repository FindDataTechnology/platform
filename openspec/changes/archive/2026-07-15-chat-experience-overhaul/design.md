## Context

Today the app runs **one module-scoped agent session shared by every WebSocket
client** (`server.js` `session`). It is created with `SessionManager.inMemory()`,
so the pi SDK does **not** persist conversation history. Instead the app keeps its
own parallel store (`chat-history.js` -> `chat-history-store/<id>.json`) that
appends the user message on `prompt` and the assistant's final text on `done`. That
store is **read-only** - the spec explicitly says "no resume into the live agent" -
and its list is shown only inside a "History" tab.

The model is never explicitly chosen at startup: `createAgentSession` is called
without a `model`, so the SDK picks "first available from settings, else first
available" - which lands on a Volces model even when LiteLLM is configured.
Skills are invoked by typing `/skill:<name>` and are only hinted via the input
placeholder. Documents are added only through the Documents-tab forms.

The pi SDK (`@earendil-works/pi-coding-agent`) already ships the primitives this
change needs:

- `createAgentSession({ model, sessionManager, continueSession })` - explicit model
  and persistent/resumed sessions.
- `SessionManager.create(cwd, sessionDir?)` - a **persistent** file-backed session
  manager (JSONL, append-only tree) that auto-saves messages on `message_end`.
- `SessionManager.inMemory()` - the current non-persistent manager.
- `SessionManager.list(cwd, sessionDir?)` -> `SessionInfo[]` - lists sessions
  (id, name, created, modified, messageCount, firstMessage) for the sidebar.
- `sessionManager.setSessionFile(path)` - "switch to a different session file (used
  for resume and branching)".
- `sessionManager.getEntries()` + `buildSessionContext(entries)` ->
  `{ messages, thinkingLevel, model }` - to read a session's messages for display.
- `session.setModel(model)` - runtime model switch (already used by the selector).

So "resume & continue" is best built **on top of the SDK's own session store** rather
than by hand-replaying messages into an in-memory agent.

Constraints to preserve (from CLAUDE.md): greenfield no-build ESM; graceful
degradation for every optional dependency; atomic persistence; event-driven UI via
`broadcast()`; tokens never reach the browser.

## Goals / Non-Goals

**Goals:**

- LiteLLM is the default chat model (with `DEFAULT_MODEL` override and Volces
  fallback).
- The left sidebar shows the chat-session list with "+ New chat"; selecting a
  session resumes it in the live agent and renders its history in the chat view.
- The LiteLLM management UI is reachable from a left-nav entry.
- `/` in the chat input opens a slash-command autocomplete for `/skill:` commands.
- Dropping files or pasting text/URLs anywhere ingests them into the document
  collection with live status feedback.

**Non-Goals:**

- Per-client agent sessions. The single shared agent session remains; switching
  chats is global (affects all connected clients), consistent with today's model.
  Per-client isolation is a future change.
- Editing or deleting past messages, branching UI, or compaction controls. The SDK
  supports these but they are out of scope.
- New document types (e.g. images). Drag/paste reuse the existing PDF/Markdown/
  text/URL pipeline only.
- Replacing the Documents tab. Its forms remain as a fallback alongside drag/paste.

## Decisions

### Decision 1: Pass an explicit default `model` to `createAgentSession`; scope by configured auth
Resolve a `Model` object from the registry at startup and pass it as
`createAgentSession({ model })`:

1. If `DEFAULT_MODEL` env is set and matches an available model id with configured
   auth, use it.
2. Else use the first available model with configured auth.

**Key finding (revealed during implementation):** the `pi-provider-litellm` extension
registers its models under **upstream provider names** (`deepseek`, `volcengine`,
`openrouter`, `groq`, …) - not a single `litellm` provider - and registers the same
ids as the Volces provider first, so it **shadows** Volces when enabled. The previous
static `EXPOSED_PROVIDERS = {volces, litellm}` therefore matched *nothing* when
LiteLLM was on (the selector was empty, and the default only worked via the SDK's
opaque "first available" heuristic). Scoping by `modelRegistry.hasConfiguredAuth(m)`
instead correctly exposes usable LiteLLM (+ Volces) models and excludes
unconfigured built-ins - which is what the `model-selection` spec already called for
("have configured auth"). The model selector and `set_model` validation now filter by
`hasAuth` and deduplicate by id (LiteLLM exposes the same model under multiple
upstream providers). The static `EXPOSED_PROVIDERS` set is removed.

The chosen default is also sent as `current_model` on connect (already happens via
`session.model?.id`).

**Why over alternatives:** The SDK's "first available" heuristic is opaque and
orders providers unpredictably; an explicit `model` makes LiteLLM-the-default
deterministic and overridable. Alternative considered: set the default via the
in-memory `SettingsManager` - rejected because passing `model` directly is simpler
and the SDK documents it as the intended knob.

### Decision 2: Adopt the SDK's persistent `SessionManager` for chat persistence + resume

Replace `SessionManager.inMemory()` with `SessionManager.create(cwd, sessionDir)`
pointed at a dedicated directory (default `sessions-store/`, overridable via
`SESSIONS_STORE_DIR` env for E2E isolation, mirroring `CHAT_HISTORY_STORE_DIR` /
`DOCUMENTS_STORE_DIR`).

- **Chat = SDK session.** One JSONL session file per chat.
- **New chat:** `sessionManager.newSession()` (creates a new session file and
  advances the leaf). Broadcast the new session list + `current_session`.
- **Switch chat:** `sessionManager.setSessionFile(path)`. Then read the loaded
  session's messages via `buildSessionContext(sessionManager.getEntries())` and
  broadcast a `session_loaded` event (id, title, messages) so every client renders
  that chat. Subsequent `prompt`s append to that session (the SDK auto-persists on
  `message_end`).
- **List:** `SessionManager.list(cwd, sessionDir)` drives the sidebar and the
  `/api/chat-history/sessions` endpoint. `SessionInfo.firstMessage`/`name` provides
  the title (set the session name from the first user message to mirror today's
  title derivation).
- **Persistence cleanup:** Remove the manual `chatHistory.appendMessage("user"...)`
  and `appendMessage("assistant"...)` calls in `server.js` - the SDK now persists.
  `chat-history.js` becomes a thin adapter over the SDK session dir (list/get/
  create/switch), keeping the existing REST endpoint shapes so the UI contract
  barely changes.

**Why over alternatives:** The SDK already implements append-only, atomic,
compaction-aware, resumable sessions. Reusing it avoids a parallel hand-rolled
store and gives true context continuity (the agent rebuilds context from the
session on each turn). Alternative considered: keep `inMemory()` + app JSON store
and re-inject history as "asides"/`sendCustomMessage` on switch - rejected as
lossy, hacky, and divergent from the SDK's model.

### Decision 3: Re-sync `agent.state.messages` on switch/new (fallback not needed)

Confirmed during implementation: `sessionManager.setSessionFile()` loads the target
file's entries into the manager but does **not** update the AgentSession's in-memory
`agent.state.messages` (only `createAgentSession` does that, at creation - sdk.js
sets `agent.state.messages = buildSessionContext().messages`). So switching must
explicitly re-sync:

```js
session.sessionManager.setSessionFile(path);
session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
```

The same pattern is used for `newSession()` (reload from the now-empty session =>
`[]`). This is sufficient for context continuity; the fallback of re-creating the
session was not needed. Verified end-to-end by the `@smoke switching sessions
resumes the conversation history` test (a real turn persists, a new session clears
the view, switching back reloads the history).

### Decision 4: One-time best-effort import of legacy `chat-history-store/`

On first run with the new sessions dir empty, import each `chat-history-store/*.json`
session into the SDK session dir: convert each `{role, content, ts}` into a
`SessionMessageEntry` (user/assistant) appended to a new SDK session, preserving id
where feasible and deriving the title from the first message. Failures are logged
per-session and skipped (graceful). The legacy dir is left intact as a backup.

**Why:** Avoids losing existing conversations. Best-effort because the legacy
format is simpler than SDK entries; tool/thinking blocks are not reconstructable.

### Decision 5: Sidebar layout - session list + LiteLLM nav entry; remove History tab

Left sidebar structure becomes:

1. Brand.
2. View tabs: **Chat, Documents, OpenConnector** (History tab removed).
3. **Chat session list** region (under the tabs, scrollable): each row shows title
   + last-updated time, with the active session highlighted; a "+ New chat" button
   on top. Clicking a row switches chats (Decision 2). This region is always visible
   (it is the chat list), independent of which view tab is active.
4. Footer: model selector, status, "Clear chat".

The **LiteLLM nav entry** is a link button placed in the sidebar (between the tabs
and the session list, or at the top of the session-list header) that opens
`${LITELLM_BASE_URL}/ui` in a new tab. It is shown only when LiteLLM is configured
(reuses `/api/config` -> `litellmManagementUrl`). The old footer
`litellm-management-link` is removed.

### Decision 6: Slash autocomplete is client-side, driven by `list_skills`

On `keydown` of `/` at the start of the input (or when the token after a space
starts with `/`), open a popup listing `availableSkills` filtered by the text typed
after `/`. Arrow-keys move selection, Enter inserts `/skill:<name> ` into the input
and refocuses so the user can append arguments; Escape closes. The popup uses the
existing `skills` WS data (already fetched on connect); no server change beyond
what `skill-invocation` already provides. Inserting (not auto-sending) keeps the
existing send flow and lets users add args.

### Decision 7: Site-wide drag-drop + paste ingestion, reusing `/api/documents`

- **Drag-drop:** `window`-level `dragover`/`drop` handlers. Prevent default browser
  file-open behavior. For each dropped file, map by extension to `pdf`/`markdown`
  (unknown text-ish extensions -> `text`), then POST as multipart to
  `/api/documents` (same as the Documents-tab upload). Show a transient toast with
  per-file status; live status flows from existing `documents_status` WS events.
- **Paste:** `window` `paste` handler. If `clipboardData.files` is present, ingest
  each as a file (above). If the paste target is **not** a text-editable element
  (`input`/`textarea`/`[contenteditable]`) and the clipboard is plain text, ingest
  it as `type: "text"`; if it parses as a URL, ingest as `type: "url"`. Pasting
  into the chat input or Documents textareas behaves normally (no hijack).
- **Guard:** when the document module is disabled (provider unconfigured), drag/
  paste shows a "document collection disabled" notice and does not call the API
  (graceful degradation). Reuse the existing 50 MB multer limit and SSRF/size caps
  already enforced server-side.

## Risks / Trade-offs

- **[Risk] `setSessionFile` may not reset the agent's in-memory message state** ->
  Mitigation: Decision 3 fallback (re-create session). Display uses
  `buildSessionContext`, so rendering is correct regardless. Confirm during impl.
- **[Risk] Global session switching confuses multi-client setups** -> one client
  switching chats switches for all. Mitigation: accepted trade-off (matches today's
  shared-session model); broadcast `session_loaded` to all clients so UIs stay in
  sync. Per-client sessions are a future Non-Goal.
- **[Risk] Legacy import is lossy or fails on corrupt files** -> Mitigation:
  per-session try/catch, log + skip; legacy dir preserved as backup; import only
  runs when the new dir is empty.
- **[Risk] Paste handler hijacks normal text entry** -> Mitigation: Decision 7 only
  auto-ingests text when the paste target is not an editable field; file pastes
  always ingest. Chat input typing is unaffected.
- **[Risk] Drag-drop conflicts with the Documents-tab file input** -> Mitigation:
  stop propagation on the file input and only handle drops on the window/body, not
  on `input[type=file]`.
- **[Trade-off] On-disk format changes** from app JSON to SDK JSONL; old E2E tests
  referencing `chat-history-store` need updating to the new `SESSIONS_DIR`.
- **[Trade-off] Default LiteLLM model is "first available litellm model"** unless
  `DEFAULT_MODEL` is set; if the proxy's first model is undesirable, the operator
  sets `DEFAULT_MODEL`.

## Migration Plan

1. Add `SESSIONS_STORE_DIR` (default `sessions-store/`) and `DEFAULT_MODEL` env
   support; update `.env`/docs.
2. Implement default-model resolution + persistent `SessionManager` wiring.
3. Implement session list/switch/new WS + REST handlers and `session_loaded`
   broadcast.
4. Add one-time legacy import (guarded to empty new dir).
5. Build sidebar session list + LiteLLM nav entry; remove History tab.
6. Add slash autocomplete; add drag-drop/paste ingestion.
7. Update E2E suite (`SESSIONS_DIR`, new session-switch flows).

**Rollback:** Revert `server.js` to `SessionManager.inMemory()` + the old
`chat-history.js`; the legacy `chat-history-store/` is untouched, so rollback
restores prior behavior. The new `sessions-store/` can be discarded.

## Open Questions

- (Resolved) `setSessionFile` does not auto-sync `agent.state.messages`; the switch
  explicitly re-syncs it (Decision 3). No session re-creation needed.
- Display title uses `SessionInfo.firstMessage` (the full first user message,
  untruncated by the SDK) truncated to 60 chars - mirrors today's `TITLE_MAX = 60`.
- "+ New chat" and `switch_session` are rejected while `isStreaming` (like
  `set_model`), to avoid switching context mid-turn.
