## ADDED Requirements

### Requirement: Server selects a default model at startup
The server SHALL select a default model when creating the agent session by passing an explicit model to the SDK. If the `DEFAULT_MODEL` environment variable is set and matches an available model id, that model SHALL be used. Otherwise the first available model with configured auth SHALL be used. Because the LiteLLM extension registers its models under upstream provider names (e.g. `deepseek`, `volcengine`, `openrouter`) with the LiteLLM API key - rather than a single `litellm` provider - and shadows the Volces provider when enabled, the first model with configured auth is a LiteLLM-routed model when LiteLLM is configured, and a Volces model otherwise. The selected default model SHALL be communicated to clients as the active model on connect. The model selector SHALL list models with configured auth (deduplicated by id), so LiteLLM models are selectable.

#### Scenario: default is a LiteLLM model when LiteLLM is configured
- **WHEN** the server starts with LiteLLM configured and `DEFAULT_MODEL` unset
- **THEN** the agent session SHALL start on a LiteLLM-routed model (a model whose auth is the LiteLLM API key)
- **AND** the `current_model` sent on connect SHALL be that model's id

#### Scenario: DEFAULT_MODEL overrides the default
- **WHEN** the server starts with `DEFAULT_MODEL` set to a valid available model id
- **THEN** the agent session SHALL start on that model
- **AND** the `current_model` sent on connect SHALL be that model's id

#### Scenario: fallback to Volces when LiteLLM is not configured
- **WHEN** the server starts without LiteLLM configured
- **THEN** the agent session SHALL start on a Volces model
- **AND** the `current_model` sent on connect SHALL be that Volces model's id

#### Scenario: LiteLLM models are selectable
- **WHEN** a client sends `{ "type": "list_models" }` and LiteLLM is configured
- **THEN** the server SHALL include LiteLLM-routed models (those with configured auth) in the `models` response
- **AND** SHALL deduplicate them by id
