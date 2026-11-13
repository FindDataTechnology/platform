## Context

This change addresses three UX issues in the chat interface:
1. No auto-focus on chat input after creating a new chat
2. Chat input not clearing after executing slash commands
3. `/model` command only shows current model, not the list of available models
4. Model selector dropdown not showing LiteLLM models correctly

The current codebase is a vanilla JS frontend (`public/app.js`) with a Node.js/Express backend (`server.js`) using WebSockets for real-time communication.

## Goals / Non-Goals

**Goals:**
- Auto-focus chat input when new chat is created
- Clear chat input after any slash command execution
- Enhance `/model` command to display list of selectable models
- Fix model selector to properly display LiteLLM models when configured

**Non-Goals:**
- No architectural changes
- No new external dependencies
- No changes to model switching logic itself
- No changes to WebSocket protocol beyond enhancing existing message

## Decisions

1. **Auto-focus implementation**: Add `inputEl.focus()` call in the `newChat()` function and on `session_loaded` event. This ensures the input is focused regardless of how the new session was triggered (button click or `/new` command).

2. **Input clearing**: Add `inputEl.value = ""` clearing in the `sendMessage()` function for server-handled commands. Local commands already clear the input. ponytail: DRY violation is acceptable here - 1 line vs. refactoring all command paths.

3. **`/model` command enhancement**: Modify `handleModelCommand()` in `server.js` to fetch the model list via `(modelRegistry?.getAvailable() ?? []).filter(hasAuth)` and include it in the `command_use` message when no argument is provided. Format as a simple list.

4. **Model selector fix**: The issue is likely in `populateModelSelect()` - `modelSelect.value = currentModelId || ""` is set before `currentModelId` is available. Check the WS message order: `current_model` may arrive before `models`. The fix: ensure `modelSelect.value` is set both when `models` arrives and when `current_model` arrives. ponytail: Already covered, but verify the exact timing.

## Risks / Trade-offs

- **Risk**: Auto-focus could steal focus from other UI elements → Mitigation: Only focus on explicit new session actions, not on page load.
- **Risk**: Model list in `/model` output could be long → Mitigation: Format as compact list, keep server-side only (no pagination needed).
- **Risk**: Timing issue between `current_model` and `models` messages → Mitigation: Apply model selection in both message handlers.
