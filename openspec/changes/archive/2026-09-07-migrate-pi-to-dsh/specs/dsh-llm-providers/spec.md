## ADDED Requirements

### Requirement: Volces provider is registered as a dsh llm adapter plugin

The server SHALL register the Volces (火山引擎) OpenAI-compatible endpoint as a dsh `ctx.llm` adapter plugin (or llm profile entry) rather than a pi provider extension. The adapter SHALL carry the base URL, API key (resolved from `VOLCES_API_KEY` or the fallback), the `openai-completions` API style, and the model list (deepseek-v4-pro, glm-5.2, etc.). The Volces provider SHALL be added to the set of exposed providers in the model selector.

#### Scenario: Volces adapter loaded at startup
- **WHEN** the server starts with `VOLCES_API_KEY` set (or the fallback available)
- **THEN** the dsh runtime SHALL load the Volces llm adapter and Volces models SHALL appear in `list_models`

#### Scenario: Volces not configured
- **WHEN** `VOLCES_API_KEY` is unset and no fallback is available
- **THEN** the Volces adapter SHALL NOT be loaded and the server SHALL log a warning

### Requirement: LiteLLM provider is registered as a dsh llm adapter plugin

The server SHALL register a LiteLLM proxy as a dsh llm adapter plugin (replacing the `pi-provider-litellm` extension) when `LITELLM_BASE_URL` and `LITELLM_API_KEY` are set. The adapter SHALL discover its model list from the proxy rather than hardcoding. LiteLLM-routed models SHALL be included in the model selector when configured.

#### Scenario: LiteLLM adapter registered at startup
- **WHEN** the server starts with `LITELLM_BASE_URL` and `LITELLM_API_KEY` set to a reachable proxy
- **THEN** the dsh runtime SHALL load the LiteLLM llm adapter, register a provider named `litellm`, and discover its models from the proxy

#### Scenario: LiteLLM proxy unreachable at startup
- **WHEN** the server starts with `LITELLM_BASE_URL` set but the proxy is unreachable
- **THEN** the server SHALL bound discovery to a short timeout, log a warning, and continue with the Volces adapter still available

#### Scenario: LiteLLM not configured
- **WHEN** the server starts without `LITELLM_BASE_URL` or `LITELLM_API_KEY`
- **THEN** the server SHALL log a warning and continue without loading the LiteLLM adapter
