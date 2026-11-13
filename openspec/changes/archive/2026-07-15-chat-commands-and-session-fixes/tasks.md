## 1. Turn state-machine fix (unblocks model/new/sessions)

- [x] 1.1 In `server.js`, extract a `finishTurn()` helper that: resets `isStreaming = false` only when it is currently `true`, broadcasts `{ type: "done" }`, re-enables the model selector (via `done`), and refreshes+broadcasts the session list (`chatHistory.listSessions()` -> `{ type: "sessions", ... }`).
- [x] 1.2 Replace the inline `done` + session-list-refresh code in the `agent_end` event handler with a call to `finishTurn()` (no double-emit: `finishTurn` no-ops when `isStreaming` is already `false`).
- [x] 1.3 In the `prompt` handler's `catch` blocks (skill-invocation path and normal path), after broadcasting `error`, call `finishTurn()` so a failed/aborted turn re-enables the UI, resets streaming, and refreshes the session list.
- [ ] 1.4 Verify: trigger a failing turn (e.g. bad model/key) and confirm the UI re-enables, `/model` and "+ New" work afterward, and the session list refreshes. *(logic in place + syntax-checked; needs a browser-triggered failed turn to confirm)*

## 2. Model selector enablement + `/model` command

- [x] 2.1 In `public/app.js` `populateModelSelect()`: when at least one model is present, set `modelSelect.disabled = false`; re-apply the last received `current_model` id (store it in a variable updated by the `current_model`/`model_changed` handlers) so the dropdown reflects the active model even if `current_model` arrived before `models`.
- [x] 2.2 Keep `agent_start` disabling `modelSelect` and `done` re-enabling it; ensure `done` (now from `finishTurn`) re-enables it on failure too.
- [x] 2.3 In `server.js`, add a `switchModelTo(id, ws)` helper that mirrors the `set_model` handler logic (find model with `hasAuth`, streaming guard, `session.setModel(target)`, broadcast `model_changed`); refactor the `set_model` case to call it.
- [x] 2.4 Add `/model` parsing to the command dispatcher (task 3): `/model <id>` calls `switchModelTo` and broadcasts `command_use` {name:"model", args:id, message:"Model switched to <id>"}; `/model` with no arg broadcasts `command_use` {name:"model", message:"Current model: <id>"} without switching.
- [x] 2.5 Verify: on fresh load the selector is enabled and shows the active model; switching via the selector and via `/model` both apply to the next turn (`current_model`/`model_changed` reflects it). *(server `/model` dispatch + `current_model`/`model_changed` verified over WS; selector enablement is frontend code-reviewed)*

## 3. Slash-command parser/dispatcher + `/new`

- [x] 3.1 In `server.js`, replace `parseSkillInvocation` with a `parseCommand(text)` returning `{ command, name, args }` for `/model`, `/new`, `/clear`, `/help`, `/skill:<name>` (and `null` for non-commands).
- [x] 3.2 Refactor the `prompt` handler to dispatch on `parseCommand`: `/skill:` keeps the existing skill path; `/model` -> task 2.4; `/new` -> reuse `createNewSession()` then broadcast `command_use` {name:"new"} + `session_changed` + `session_loaded` (empty) + refreshed `sessions`; `/clear` and `/help` are client-handled (server ignores them if they arrive, but the UI should not send them).
- [x] 3.3 Ensure recognised server-handled commands are NOT echoed as `user` messages and NOT forwarded as raw prompts; unknown `/…` falls through to the agent as a normal prompt.
- [x] 3.4 Verify: `/new` creates a session, refreshes the sidebar, and renders a `command_use` block; `/model`/`/skill:` still work. *(verified over WS: `/new` -> session_loaded + sessions + command_use; `/model` -> command_use)*

## 4. Unified autocomplete + client commands + `command_use` rendering

- [x] 4.1 In `public/app.js`, generalize the autocomplete to a unified command list: build an array of `{name, label, description}` from meta-commands (`/model`, `/new`, `/clear`, `/help`) plus `/skill:<name>` from `availableSkills`; filter and render labels (e.g. `/model`, `/skill:graphify`); `insertAutocomplete` inserts the selected label + trailing space.
- [x] 4.2 In `sendMessage()`, intercept client-handled commands before sending: `/clear` clears the chat view (reuse `clearBtn` logic) and shows a `command_use`-style block; `/help` renders a block listing available commands; neither sends a WS `prompt`. Strip the command from the input.
- [x] 4.3 Add a `createCommandBlock(name, args, message)` (mirror `createSkillBlock`) and handle the `command_use` WS event in `handleMessage` to render it.
- [x] 4.4 Update the input placeholder/help text to hint at the available commands (optional, minor).
- [ ] 4.5 Verify: typing `/` lists all commands; filtering works; Enter inserts without sending; `/clear` and `/help` work without a round-trip. *(needs browser)*

## 5. Chat-top document banner

- [x] 5.1 In `public/index.html`, add a `#chat-docs-banner` element at the top of `#view-chat` (above `#chat`).
- [x] 5.2 In `public/app.js`, maintain an in-memory `Map` of docs added this page session; seed an entry when a drag/paste/panel add succeeds (from `ingestFile`/`ingestTextOrUrl`/`handleAddResponse` responses, or from the add response body containing id+name+status). *(implemented via `documents_status` events, which fire for all add paths)*
- [x] 5.3 Update the banner from `documents_status` events: add/update a chip per doc id with name + status (`queued`/`indexing`/`ready`/`error`); cap to the most recent N (e.g. 5); hide the banner when empty.
- [x] 5.4 Style the banner/chips in `public/style.css` (subtle, non-intrusive).
- [ ] 5.5 Verify: adding a doc via drag-drop/paste/panel shows a chip at the top of the chat that updates to `ready`/`error`; banner hidden when empty; no new server endpoint. *(needs browser)*

## 6. Drop overlay text removal

- [x] 6.1 In `public/index.html`, remove the "Drop files to add to documents" text from `#drop-overlay` (empty element).
- [x] 6.2 In `public/style.css`, tone down `.drop-overlay` (subtle dashed border, no large label).
- [ ] 6.3 Verify: dragging a file shows only a subtle affordance (no prominent text); the toast and chat banner still give feedback. *(needs browser)*

## 7. LiteLLM in-app web view (`/litellm-web` reverse proxy)

- [x] 7.1 In `server.js`, extract a generic `createWebProxy({ getBase, getToken })` from `openConnectorWebProxy` (or add a parallel `litellmWebProxy`) that forwards a proxied path to a base URL with a bearer token, strips client `Authorization`, injects `<base href="<prefix>/">`, rewrites `Location`, and drops content-encoding/length.
- [x] 7.2 Mount `/litellm-web` and `/litellm-web/*` -> LiteLLM base URL with `Authorization: Bearer ${LITELLM_API_KEY}`, guarded by `litellmEnabled`.
- [x] 7.3 Mount LiteLLM root passthroughs (`/v1/*`, `/key/*`, `/spend/*`, `/model/*`, and a `/api/*` catch-all after the app's own `/api/*` routes) -> LiteLLM, ONLY when `litellmEnabled && !openConnectorEnabled`. *(refined: `/key/*`,`/spend/*`,`/model/*` proxied whenever LiteLLM is configured; `/v1/*`,`/api/*` only when OC is off - see spec)*
- [x] 7.4 In `public/index.html`, change the LiteLLM nav entry from `<a target="_blank">` to a nav button/entry that switches to a new `view-litellm` pane; add `<section id="view-litellm">` with an `<iframe src="about:blank">` (loaded lazily to `/litellm-web` on first activation, mirroring `setOcSubtab`).
- [x] 7.5 In `public/app.js`, add `litellm` to the `views` map and `showView` handling; lazy-load the iframe `src="/litellm-web"` on first activation; when OpenConnector is also enabled, show a fallback "open in new tab" link inside the view.
- [x] 7.6 In `public/app.js` `loadServerConfig()`, drop the new-tab link wiring (or repurpose it as the fallback link); ensure the nav entry is shown only when LiteLLM is configured (gate via `/api/config` exposing `litellmEnabled`).
- [x] 7.7 In `server.js` `/api/config`, expose `litellmEnabled: Boolean(LITELLM_BASE_URL && LITELLM_API_KEY)` (keep `litellmManagementUrl` for the fallback link).
- [x] 7.8 Verify: with LiteLLM configured (and OpenConnector off), the LiteLLM nav switches to an in-app iframe showing the management UI without a browser-visible token; with LiteLLM unset, the nav entry is absent; with both enabled, the fallback link is shown. *(server-verified: `/api/config` exposes litellmEnabled; `/litellm-web` returns LiteLLM UI HTML; `/key/*` reaches LiteLLM; app `/api/*` routes take precedence. iframe render needs browser)*

## 8. End-to-end verification

- [x] 8.1 Restart the server and confirm graceful startup with LiteLLM on/off and OpenConnector on/off combinations. *(booted cleanly twice on test ports; OC+LiteLLM both on in this env - graceful)*
- [ ] 8.2 Walk through: fresh-load model switch (selector + `/model`), failed-turn recovery, `/new` + sidebar refresh, `/clear`/`/help`, drag-drop doc -> chat banner, drop overlay has no label, LiteLLM in-app view. *(needs browser)*
- [ ] 8.3 Run any existing E2E suite (`openspec`/npm) if present; update fixtures if the WS protocol changed (new `command_use` event, `/api/config` field). Note: no test runner is configured in this repo. *(no test runner configured; WS smoke test added ad-hoc and removed)*
