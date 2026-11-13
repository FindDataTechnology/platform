## MODIFIED Requirements

### Requirement: Server lists available models to the client
The server SHALL respond to a `list_models` WebSocket message with the set of models available to the agent, each including its id, display name, and provider. When LiteLLM is configured, the server SHALL fetch the model list directly from the LiteLLM proxy's OpenAI-compatible `/v1/models` endpoint (`GET ${LITELLM_BASE_URL}/v1/models` authenticated with the `LITELLM_API_KEY`), and SHALL return exactly the model ids reported by the proxy, each with `provider: "litellm"`. Native Volces chat models SHALL NOT appear in the client-facing list under any condition when LiteLLM is configured. The fetch SHALL be bounded by a short timeout; on failure the server SHALL log a warning and fall back to the LiteLLM-routed models in the server's model registry (the LiteLLM extension's models), without exposing Volces models and without aborting the request; if no LiteLLM-routed model is available the server SHALL return an empty list. When LiteLLM is NOT configured, the server SHALL return models from the server's configured Volces provider that have configured auth. Models SHALL be deduplicated by id. The list SHALL reflect the live proxy state so that models added through the LiteLLM admin UI appear without a server restart.

#### Scenario: client requests the model list (LiteLLM configured)
- **WHEN** a WebSocket client sends `{ "type": "list_models" }` and LiteLLM is configured
- **THEN** the server SHALL fetch `${LITELLM_BASE_URL}/v1/models` and reply with `{ "type": "models", "models": [ ... ] }` containing exactly the ids the proxy reports, each with `provider: "litellm"`
- **AND** SHALL deduplicate them by id
- **AND** SHALL NOT include any native Volces model id

#### Scenario: LiteLLM proxy unreachable during list_models
- **WHEN** a WebSocket client sends `{ "type": "list_models" }` and the LiteLLM proxy is unreachable
- **THEN** the server SHALL log a warning and reply with the LiteLLM-routed models from the registry, or an empty list if none exist
- **AND** SHALL NOT include any native Volces model id
- **AND** SHALL NOT abort the request

#### Scenario: client requests the model list (no LiteLLM)
- **WHEN** a WebSocket client sends `{ "type": "list_models" }` and LiteLLM is NOT configured
- **THEN** the server SHALL reply with `{ "type": "models", "models": [ ... ] }` containing models from the server's configured Volces provider that have configured auth
- **AND** SHALL deduplicate them by id

### Requirement: Server selects a default model at startup
The server SHALL select a default model when creating the agent session by passing an explicit model to the SDK. If the `DEFAULT_MODEL` environment variable is set and matches an available model id, that model SHALL be used. When LiteLLM is configured, the server SHALL register only the LiteLLM provider extension for the agent (the native Volces chat provider SHALL NOT be registered), so every model with configured auth is a LiteLLM-routed model; the default SHALL be a LiteLLM-routed model (the first such model, or the `DEFAULT_MODEL` match). The server SHALL detect LiteLLM-routed models by configured auth on the LiteLLM-only registry, not by a `provider === "litellm"` string match (the LiteLLM extension registers models under upstream provider names such as `deepseek`, `volcengine`, `openrouter`). When LiteLLM is NOT configured, the server SHALL register only the Volces provider and the default SHALL be a Volces model. The selected default model SHALL be communicated to clients as the active model on connect. When LiteLLM is configured but no LiteLLM-routed model is resolvable (e.g. the proxy is unreachable at startup and the extension registered nothing), the server SHALL log a clear error and pass no explicit model to the SDK.

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

#### Scenario: LiteLLM configured but no model resolvable
- **WHEN** the server starts with LiteLLM configured but the proxy is unreachable and no LiteLLM-routed model is registered
- **THEN** the server SHALL log a clear error
- **AND** SHALL NOT start the agent on a Volces model
- **AND** the model selector SHALL show no models

#### Scenario: LiteLLM models are selectable
- **WHEN** a client sends `{ "type": "list_models" }` and LiteLLM is configured
- **THEN** the server SHALL include LiteLLM-routed models in the `models` response
- **AND** SHALL deduplicate them by id
- **AND** SHALL NOT include Volces models

### Requirement: User can switch the active model at runtime
The server SHALL accept a `set_model` WebSocket message OR a `/model <id>` chat command and switch the agent session's active model via the SDK's runtime model-switch API, validating that the requested model is available, has configured auth, and - when LiteLLM is configured - is a LiteLLM-routed model. When LiteLLM is configured, the server SHALL reject a switch to a native Volces model id even if it would otherwise match. A `/model` command with no argument SHALL report the currently active model. The switched model SHALL apply to the next agent turn. (Model switching is rejected while the agent is streaming, per the dedicated streaming-guard requirement.)

#### Scenario: user selects a valid model via the selector
- **WHEN** a client sends `{ "type": "set_model", "id": "deepseek-v4-flash" }` for a LiteLLM-routed model in the available list
- **THEN** the server SHALL switch the session's active model and broadcast `model_changed` with the new id

#### Scenario: user switches model via the /model command
- **WHEN** a client sends `{ "type": "prompt", "text": "/model deepseek-v4-pro" }` for a LiteLLM-routed model in the available list
- **THEN** the server SHALL switch the session's active model and broadcast `model_changed` with the new id
- **AND** SHALL broadcast a `command_use` event for the `model` command

#### Scenario: /model with no argument reports the current model
- **WHEN** a client sends `{ "type": "prompt", "text": "/model" }`
- **THEN** the server SHALL broadcast a `command_use` event reporting the currently active model
- **AND** SHALL NOT switch the model

#### Scenario: user selects an unknown model
- **WHEN** a client sends `set_model` or `/model nonexistent` for a model not in the available list
- **THEN** the server SHALL send an `error` message and the active model SHALL remain unchanged

#### Scenario: Volces model rejected when LiteLLM is configured
- **WHEN** a client sends `set_model` or `/model` with a native Volces model id (e.g. `glm-5.2`) while LiteLLM is configured
- **THEN** the server SHALL send an `error` message and the active model SHALL remain unchanged
- **AND** SHALL NOT switch to the Volces model
