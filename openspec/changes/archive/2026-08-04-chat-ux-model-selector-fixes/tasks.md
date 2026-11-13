## 1. Chat Input Auto-Focus

- [x] 1.1 Add `inputEl.focus()` to `newChat()` function in `public/app.js`
- [x] 1.2 Add `inputEl.focus()` to `session_loaded` event handler in `public/app.js`

## 2. Input Clearing After Slash Commands

- [x] 2.1 Ensure chat input is cleared after sending server-handled slash commands in `public/app.js`
- [x] 2.2 Verify local commands (`/clear`, `/help`) already clear input

## 3. Enhance /model Command

- [x] 3.1 Modify `handleModelCommand()` in `server.js` to fetch available models when no argument is provided
- [x] 3.2 Update `command_use` message to include formatted model list with current model indicator

## 4. Fix Model Selector for LiteLLM

- [x] 4.1 Verify `current_model` and `models` WS message ordering and timing in `public/app.js`
- [x] 4.2 Ensure `modelSelect.value` is set correctly after both `current_model` and `models` messages
- [x] 4.3 Verify LiteLLM models are included in the models list from the server

## 5. Verification

- [x] 5.1 Test auto-focus works on new chat button click
- [x] 5.2 Test auto-focus works on `/new` command
- [x] 5.3 Test input clears after all slash commands
- [x] 5.4 Test `/model` command shows current model + list of models
- [x] 5.5 Test LiteLLM models appear in model selector when configured
