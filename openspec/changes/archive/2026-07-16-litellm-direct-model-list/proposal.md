## Why

The pi SDK's model registry doesn't reliably reflect the actual models available in the LiteLLM proxy. Fetching directly from LiteLLM's `/v1/models` endpoint gives the true list of models that are actually configured and routable.

## What Changes

- **NEW**: Fetch model list directly from `LITELLM_BASE_URL + /v1/models when LiteLLM is configured
- **REMOVE**: The ⚙️ command list button and popup from the UI
- **KEEP**: `/model` chat command and the bottom-left model selector dropdown, both working with the new LiteLLM model source
- **FALLBACK**: When LiteLLM is not configured, fall back to the existing model registry behavior

## Capabilities

### Modified Capabilities
- `model-selection`: Model list source changes from pi SDK model registry to direct LiteLLM /v1/models fetch
- `chat-commands`: Remove command list button removed from UI (slash commands still work via typing /)

## Impact

Affected files:
- `server.js`: Modify `list_models` handler to fetch from LiteLLM /v1/models endpoint
- `public/index.html`: Remove the command list button and popup DOM elements
- `public/app.js`: Remove command list popup JavaScript code and event listeners
- `public/style.css`: Remove command list popup styles
