## Context

The chat window is the primary surface of the app, but several interactions are broken or missing. Three of the reported bugs (model selector does nothing, "+ New" button dead, chat-history sidebar not refreshing) share a single root cause in the turn state machine: the `prompt` handler's `catch` broadcasts an `error` but never resets `isStreaming` or broadcasts `done`. Once any turn fails (e.g. a model API error) before the SDK emits `agent_end`, `isStreaming` stays `true` forever, so every later `set_model` and `new_session` is rejected with "Cannot switch model / start a new chat while the agent is responding", and the `done`-triggered session-list refresh never fires. Separately, `#model-select` is only re-enabled on `done` (never on connect or when models arrive), so on a fresh load it is disabled until the first turn completes.

Beyond fixes, the user wants a richer in-input command system (`/model`, `/new`), documents added during a session surfaced at the top of the chat, a less noisy drag-drop overlay, and the LiteLLM management UI embedded in-app (mirroring OpenConnector's `/oc-web` token-injecting reverse proxy) instead of opening a new tab. Today the only parsed command is `/skill:<name>` (`parseSkillInvocation` in `server.js`), the drop overlay shows a full-screen "Drop files to add to documents" label, and the LiteLLM nav is an `<a target="_blank">` to `${LITELLM_BASE_URL}/ui`.

Constraints: greenfield no-build ESM Node, vanilla-JS frontend, one shared agent session, graceful degradation for every optional dependency, and "tokens never reach the browser". The pi SDK's `AgentSession` exposes `setModel(model)` and a `sessionManager` but no higher-level `switchSession`/`withSession`, so session swap stays on the current `sessionManager` + `agent.state.messages` re-sync pattern.

## Goals / Non-Goals

**Goals:**
- Unify slash commands behind one parser/dispatcher with one autocomplete, adding `/model`, `/new`, `/clear`, `/help` alongside `/skill:`.
- Make model switching reliable from both the selector and `/model`, and actually apply to the next turn.
- Fix the turn state machine so a failed turn cannot wedge model-switching, new-session, or the session-list refresh.
- Make "+ New" and session switching reliably mutate the live agent and refresh the sidebar, including after a failed turn.
- Surface documents added during a session as a banner at the top of the chat view.
- Remove the noisy drag-drop overlay text.
- Embed the LiteLLM management UI in-app via a token-injecting reverse proxy, mirroring OpenConnector.

**Non-Goals:**
- Per-chat-session document scoping (documents remain a global collection; the banner reflects docs added in the current page session).
- Rewriting the LiteLLM or OpenConnector SPAs to use a base path; we rely on a `<base>` tag + root passthroughs, as OpenConnector already does.
- Changing the SDK's session-persistence model or adding new dependencies.
- Multi-user / per-connection agent sessions.

## Decisions

### 1. A single command table drives parsing, dispatch, and autocomplete
Replace `parseSkillInvocation` with a `parseCommand(text)` that recognises a first token from a table: `/model`, `/new`, `/clear`, `/help`, `/skill:<name>`. Commands split into **server-handled** (`/model`, `/new`, `/skill:` — they mutate agent/server state) and **client-handled** (`/clear`, `/help` — pure UI, intercepted in `sendMessage` before any WS send, so they never reach the agent). The autocomplete popup is generalised from "skills only" to a unified list of all commands (each with name + description), filtered by typed text; selecting inserts the command text plus a trailing space. Rationale: one source of truth for what commands exist, surfaced consistently in autocomplete and dispatch. Alternatives considered: keep `/skill:` special-cased and add separate parsers per new command (rejected — divergent parsing and two autocomplete sources); route every command through the server including `/clear`/`/help` (rejected — pointless round-trips for pure-UI actions).

### 2. `/model` reuses the `set_model` path; `/new` reuses `createNewSession`
`/model <id>` extracts the id and calls the same logic as the `set_model` WS handler (find model with configured auth, enforce the streaming guard, `session.setModel(target)`, broadcast `model_changed`). `/model` with no argument broadcasts a short informational `command_use` listing the current model and available ids. `/new` calls the existing `createNewSession()` and emits the same `session_changed`/`session_loaded`/`sessions` sequence as the `new_session` button handler. Rationale: no second implementation of model-switch or session-creation; the selector, the button, and the commands share one code path each.

### 3. A `command_use` event renders meta-commands as blocks
Introduce `{ type: "command_use", name, args, message? }` rendered as a collapsible block (mirroring `skill_use`), used for `/model` and `/new` (and client-side for `/clear`/`/help`). `skill_use` is retained unchanged for `/skill:` to preserve the existing `skill-invocation` contract. Rationale: users see that a command ran (e.g. "Model switched to deepseek-v4-pro") instead of the raw `/model …` text being echoed as a user message, consistent with how skills render.

### 4. Fix the turn state machine with a `finishTurn()` helper
Extract a `finishTurn()` that sets `isStreaming = false`, re-enables the model selector (broadcasts `done`), and refreshes the session list. Call it from the `agent_end` event handler (replacing the inline `done` + list-refresh) AND from the `prompt` `catch` (after broadcasting `error`). Guard against a double `done` (SDK emits `agent_end` after the catch) by only acting when `isStreaming` is currently `true`. Rationale: guarantees the UI re-enables and the session list refreshes on every turn end regardless of success/failure, which is what unblocks the selector, "+ New", and the sidebar. Alternative: rely solely on SDK `agent_end` (rejected — it does not fire when `prompt()` rejects).

### 5. Enable the model selector as soon as models are known
`populateModelSelect` sets `#model-select.disabled = false` when it has at least one option, and re-applies the last `current_model` id so the dropdown reflects the active model even if `current_model` arrived before the `models` list. `agent_start` still disables it mid-turn; `finishTurn` re-enables it. Rationale: the selector must be usable on a fresh load without first completing a turn.

### 6. New-session/switch re-sync the live agent and always refresh the list
Keep the `sessionManager.newSession()` / `setSessionFile()` + `agent.state.messages = buildSessionContext().messages` pattern (the SDK offers no higher-level swap), but always broadcast a refreshed `sessions` list on success AND ensure `finishTurn()` refreshes it after a failed turn so a just-created session appears even when its first turn errors. Rationale: the direct-poke pattern is the only available one; the reliability gap was the missing refresh after failure, not the swap mechanism itself.

### 7. Chat-top document banner driven by `documents_status`
Add a `#chat-docs-banner` above `#chat` in `view-chat`. The frontend keeps an in-memory `Map` of documents added during this page session (seeded when a drag/paste/panel add succeeds, and updated by `documents_status` events for those ids). Each entry renders as a chip showing name + status (`indexing`/`ready`/`error`); the banner is capped to the most recent N (e.g. 5) and hidden when empty. Rationale: reuses the existing `documents_status` event stream; no new server endpoint; gives immediate in-chat visibility of what was added. Documents remain global — the banner is a page-session view, not per-chat persistence.

### 8. Remove the drag-drop overlay text; tone down the overlay
Empty `#drop-overlay`'s text content and reduce the overlay CSS to a subtle dashed border with no large label (drop feedback already comes from the toast and now the chat banner). Rationale: the user finds the full-screen label noisy; the affordance remains via the subtle border + toast.

### 9. LiteLLM `/litellm-web` reverse proxy mirroring `/oc-web`
Add `litellmWebProxy` (a copy of `openConnectorWebProxy` parameterised by base + token) that forwards `/litellm-web` and `/litellm-web/*` to `LITELLM_BASE_URL`, injects `Authorization: Bearer ${LITELLM_API_KEY}`, strips client `Authorization`, injects `<base href="/litellm-web/">`, rewrites `Location` redirects, and drops `content-encoding`/`content-length`. Mount it (and a `view-litellm` pane with an `<iframe src="/litellm-web">`) only when `litellmEnabled`. The LiteLLM nav entry becomes a view switch (like OpenConnector) instead of `target="_blank"`. For the SPA's absolute API calls, mount root-level passthroughs for LiteLLM's non-conflicting admin roots (`/key/*`, `/spend/*`, `/model/*`) whenever LiteLLM is configured, and the contested `/v1/*` + `/api/*` catch-all **only when OpenConnector is not enabled** (OpenConnector already owns those roots when enabled). This keeps the embedded LiteLLM management UI largely functional even when both are enabled; only `/v1` and `/api` calls fall back to a new-tab link. Rationale: mirrors the proven OpenConnector pattern; honours "tokens never reach the browser". The common case (LiteLLM on, OpenConnector off) has no conflict; the both-on case still gets partial in-window functionality.

## Risks / Trade-offs

- **[Risk] Root passthrough conflict when both LiteLLM and OpenConnector are enabled** — `/v1/*` and `/api/*` can only be owned by one proxy. -> Mitigation: LiteLLM mounts those root passthroughs only when `!openConnectorEnabled`; when both are on, the LiteLLM view embeds via `/litellm-web` (HTML + relative assets work) but its absolute `/v1/*`/`/api/*` calls are misrouted, so the view shows a fallback "open in new tab" link. Document this limitation.
- **[Risk] LiteLLM UI auth model differs from OpenConnector's** — LiteLLM may expect a session cookie rather than a bearer header, or its UI may hardcode absolute hosts. -> Mitigation: inject the bearer header on every proxied request (satisfies the API); verify against the deployed LiteLLM version during apply and fall back to the new-tab link if the embedded UI does not function.
- **[Risk] Double `done` / double list-refresh** if the SDK emits `agent_end` after the `prompt` catch. -> Mitigation: `finishTurn()` is a no-op when `isStreaming` is already `false`.
- **[Risk] Direct `sessionManager` poke leaves SDK internal caches stale** (extension runner, compiled context) after new/switch. -> Mitigation: the existing pattern already works for switch; keep it, but if a switched/new session misbehaves during apply, investigate `agent.state` re-sync. Non-blocking for the state-machine fix.
- **[Trade-off] `/clear` and `/help` are client-only** — they won't appear in server logs or affect the agent. Acceptable: they are pure UI.
- **[Trade-off] Document banner is page-session-scoped**, not per-chat-session. Acceptable: documents are global; the banner is an "I just added this" affordance.

## Migration Plan

No data migration. Deploy is a restart of `node server.js`. Rollback is reverting the files (no schema/env changes). The LiteLLM web proxy is additive and only active when `LITELLM_BASE_URL`/`LITELLM_API_KEY` are set; the new-tab link can be restored by reverting the nav-entry change. Existing sessions on disk are unaffected.

## Open Questions

- Exact set of LiteLLM UI API path roots to passthrough (`/key/*`, `/spend/*`, `/model/*`, …) — confirm against the deployed LiteLLM version's SPA during apply.
- Whether `/model <partial>` should fuzzy-match model ids or require an exact id (default: exact id, with an error listing candidates) — keep exact for predictability unless the user asks otherwise.
- Whether the doc-on-top banner chips should auto-dismiss when `ready` or persist until cleared (default: persist, capped to N most-recent).
