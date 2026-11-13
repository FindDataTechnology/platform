## Why

This change improves chat UX usability and fixes model selector inconsistencies. The auto-focus on new chat improves workflow speed, the slash-command input clearing is a quality-of-life fix, and the model selector bug prevents users from selecting LiteLLM models from the dropdown.

## What Changes

- Auto-focus the chat input when clicking the "New" chat button
- Clear the chat input field after executing any slash command
- `/model` command with no argument displays the list of selectable models
- Fix the model selector dropdown showing wrong models (not showing LiteLLM models)

## Capabilities

### New Capabilities

- `chat-input-focus`: Auto-focus behavior for chat input on new session

### Modified Capabilities

- `chat-commands`: Add input clearing after slash command execution, enhance `/model` command to display model list
- `model-selection`: Fix model selector to properly display LiteLLM models

## Impact

- Affected files: `public/app.js` (chat input focus, input clearing, model selector rendering)
- Affected files: `server.js` (model list generation, `/model` command output)
