## Context

Currently, the `list_models` WebSocket handler returns all models with configured auth (`hasAuth` filter + dedupe by id). When LiteLLM is configured, it registers models under upstream provider names (deepseek, volcengine, openrouter, etc.) which shadow the Volces provider. This means the model list shows both LiteLLM-routed models AND native Volces models when both are configured, but users only want to see LiteLLM models.

The frontend model selector is a simple dropdown with no easy way to see or search models. There is no visible command list - users must know slash commands by heart.

## Goals / Non-Goals

**Goals:**
1. Filter model list to LiteLLM-routed models only when LiteLLM is configured
2. Add a visible command list popup showing all slash commands and available models
3. Allow users to select a model directly from the command list

**Non-Goals:**
1. Changing the underlying provider registration mechanism
2. Adding model search/filter beyond what's already available
3. Adding new server-side commands beyond existing `/model` behavior

## Decisions

1. **LiteLLM detection heuristic**: Use a simple check - if the litellm extension was loaded (check `LITELLM_BASE_URL` and `LITELLM_API_KEY` env vars), then filter models to those whose auth matches the LiteLLM API key. This works because LiteLLM-routed models all share the same LiteLLM API key for auth.

2. **Command list UI**: Add a button next to the model selector that opens a popup showing:
   - Available slash commands (`/model`, `/new`, `/clear`, `/help`, skills)
   - Available models as clickable items that trigger model selection

3. **Model selection from command list**: Clicking a model in the command list sends `set_model` directly, same as the dropdown.

## Risks / Trade-offs

- **Risk**: Litellm detection based on env vars could be out of sync with actual extension loading
  → **Mitigation**: Track a `litellmLoaded` flag when the extension is actually registered, use that for filtering

- **Risk**: Filtering out Volces models means fallback won't work if LiteLLM fails
  → **Mitigation**: Keep Volces models in the server's internal fallback logic; only filter the client-facing list
