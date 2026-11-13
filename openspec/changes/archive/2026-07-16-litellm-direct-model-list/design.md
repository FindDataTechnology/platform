## Context

Currently, the server uses the pi SDK's `modelRegistry.getAvailable()` to populate the model list. This doesn't accurately reflect what models are actually configured in the LiteLLM proxy, since the extension registers a fixed set of upstream provider names rather than querying the real model list.

## Goals / Non-Goals

**Goals:**
1. Fetch the true model list directly from LiteLLM's `/v1/models` endpoint
2. Remove the command list button UI that was just added
3. Keep `/model` chat command and bottom-left model selector working

**Non-Goals:**
1. Changing model switching logic (set_model) - models still work the same way
2. Changing the default model resolution logic

## Decisions

1. **Fetch strategy**: On `list_models` WebSocket message, if `litellmEnabled`, fetch from `${LITELLM_BASE_URL}/v1/models` with `Authorization: Bearer ${LITELLM_API_KEY}` header.
2. **Response mapping**: LiteLLM returns `{ data: [{ id: "...", ... }] }` → map to our format `{ id, name: id, provider: "litellm" }`
3. **Fallback**: If LiteLLM fetch fails or is not configured, fall back to the existing modelRegistry behavior
4. **Cleanup**: Remove all command list button/popup code from HTML, JS, and CSS

## Risks / Trade-offs

- **Risk**: LiteLLM endpoint might be unreachable or return errors
  → **Mitigation**: Fall back to existing model registry behavior with console warning
- **Risk**: LiteLLM model IDs might not match what the pi SDK expects
  → **Mitigation**: Model switching still works through the same SDK path; if a model ID is invalid, the existing error handling applies
