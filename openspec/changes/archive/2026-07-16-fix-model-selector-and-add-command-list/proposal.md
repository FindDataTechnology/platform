## Why

The chat window shows all models with configured auth, including both Volces and LiteLLM models. When LiteLLM is configured, users only want to see LiteLLM-routed models. Additionally, the model selector has usability issues: users cannot easily see available commands or pick a specific model from the list.

## What Changes

- **Filter model list to LiteLLM-only**: When LiteLLM is configured, the model selector (`/model` command and dropdown) only shows models routed through LiteLLM, not Volces models
- **Add command list popup**: The chat UI provides a visible command list button that shows all available slash commands and models, allowing users to select a model directly from the list
- **Fix model selection**: Ensure the model selector properly reflects and applies the selected model

## Capabilities

### Modified Capabilities
- `model-selection`: Requirement changes to filter models by LiteLLM provider when configured, and improve model selection UX
- `chat-commands`: Requirement changes to add a visible command list popup with model selection

## Impact

Affected files:
- `server.js`: Modify `list_models` handler to filter LiteLLM models when configured
- `public/app.js`: Add command list UI and improve model selector behavior
