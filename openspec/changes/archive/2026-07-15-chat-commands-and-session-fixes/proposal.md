## Why

The chat window has several broken or missing interactions that block normal use: changing the model from the bottom-left selector silently does nothing, the "+ New" button and the chat-history sidebar often stop working, and the only in-input command is `/skill:`. A failed model turn wedges the agent so model-switching and new-session creation stay permanently rejected. At the same time the user wants richer slash commands (`/model`, `/new`), document additions surfaced in the chat, a less noisy drag-drop overlay, and the LiteLLM management UI embedded in-app (like OpenConnector) instead of popping a new tab.

## What Changes

- **Generalize the chat slash-command system.** Beyond `/skill:<name>`, the chat input accepts `/model <id>` (switch the session's active model), `/new` (start a new chat session), `/clear` (clear the chat view), and `/help` (list commands). The autocomplete popup lists skills *and* these meta-commands, filtered by typed text.
- **Add `/model` as an in-session model control.** Typing `/model <id>` switches the active model for the current session (same validation and streaming-guard as the selector); `/model` with no argument reports the current model.
- **Fix the model selector.** The bottom-left `<select>` is enabled as soon as models are known (on connect), not only after the first turn completes; the selected model actually applies to the next turn.
- **Fix the turn state machine.** A failed or aborted turn resets streaming state and emits `done`, so model-switching and new-session creation are never permanently blocked and the UI re-enables. This unblocks the model selector, the "+ New" button, and the session-list refresh.
- **Fix the "+ New" button and chat-history sidebar.** New-session creation and session switching reliably mutate the live agent and refresh the sidebar list (including after a failed turn).
- **Add `/new` as an alternative way to start a session.**
- **Surface documents added during a session.** When a document is added (drag-drop, paste, or the Documents panel), a banner at the top of the chat view shows the recently added document(s) and their indexing status, driven by existing `documents_status` events.
- **Remove the noisy drag-drop overlay text.** The full-screen "Drop files to add to documents" text is removed; drop feedback is conveyed by the toast and (subtly) the new chat banner. The drag affordance is toned down.
- **Embed the LiteLLM management UI in-app.** The LiteLLM sidebar entry switches to an in-app view (like OpenConnector) that loads the proxy's management UI through a token-injecting `/litellm-web` reverse proxy, so the admin key never reaches the browser. The current new-tab link is replaced.

## Capabilities

### New Capabilities
- `chat-commands`: A general slash-command system in the chat input. The server parses `/model`, `/new`, `/clear`, and `/help` (alongside existing `/skill:`), dispatches each to its behavior, broadcasts a `command_use` event rendered as a collapsible block, and the UI offers unified autocomplete over all commands.
- `litellm-web`: Embeds the LiteLLM proxy's management UI in-app via a token-injecting `/litellm-web` reverse proxy (mirrors `open-connector-web`), mounted only when LiteLLM is configured, so the server-held admin token is injected server-side and never reaches the browser.

### Modified Capabilities
- `model-selection`: add `/model <id>` as an accepted runtime model-switch trigger (same validation/streaming-guard as `set_model`); require the selector to be enabled once models are known and that a switch applies to the next turn.
- `skill-invocation`: the slash-command autocomplete lists skills alongside the new meta-commands (unified command table); skill invocation continues to render as a block and is one entry in the broader command system.
- `chat-history`: add `/new` as a session-creation trigger; require the session list to refresh after new/switch and after a failed turn; require new-session/switch to reliably re-sync the live agent's messages.
- `chat-streaming`: a failed or aborted turn SHALL reset streaming state and emit `done` (after any `error`) so the UI re-enables, model-switching/new-session are unblocked, and the session list refreshes.
- `document-management`: when a document is added during a session, the chat view shows a banner of recently added documents with live indexing status (driven by `documents_status`).
- `app-navigation`: the LiteLLM sidebar entry switches to the in-app LiteLLM view (mirroring OpenConnector) instead of opening a new tab; the drag-drop overlay text is removed and the overlay toned down.

## Impact

- **Backend (`server.js`)**: replace the `/skill:`-only `parseSkillInvocation` with a general command parser/dispatcher; add `/model` and `/new` handlers reusing the `set_model` and `createNewSession` logic; fix the `prompt` catch to reset `isStreaming` + broadcast `done`; ensure the `sessions` list refreshes after a failed turn; mount the `/litellm-web` reverse proxy (token-injected, mirroring `openConnectorWebProxy`) and its root-level asset/API passthroughs, guarded by `litellmEnabled` and de-conflicted from OpenConnector's root proxies.
- **Frontend (`public/app.js`, `index.html`, `style.css`)**: enable `#model-select` on connect/model-list and keep it in sync with `current_model`; generalize the autocomplete popup to a unified command list; render `command_use` blocks; add the chat-top document banner driven by `documents_status`; convert the LiteLLM nav entry into a view switch (add a `view-litellm` pane with an iframe to `/litellm-web`); remove the drop-overlay text and tone down the overlay.
- **No new dependencies**; all changes use existing Express/WS/LlamaIndex plumbing. Graceful degradation is preserved: LiteLLM web embed is absent when LiteLLM is unconfigured; document banner is absent when the document module is disabled.
- **Specs touched**: new `chat-commands`, `litellm-web`; deltas to `model-selection`, `skill-invocation`, `chat-history`, `chat-streaming`, `document-management`, `app-navigation`.
