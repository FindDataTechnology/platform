## MODIFIED Requirements

### Requirement: Server lists available models to the client
The server SHALL respond to a `list_models` WebSocket message with the set of models available to the agent, each including its id, display name, and provider. When LiteLLM is configured, the server SHALL fetch the model list directly from the LiteLLM proxy's OpenAI-compatible `/v1/models` endpoint (`GET ${LITELLM_BASE_URL}/v1/models` authenticated with the `LITELLM_API_KEY`), and SHALL return exactly the model ids reported by the proxy, each with `provider: "litellm"`, excluding native Volces models from the client-facing list. The fetch SHALL be bounded by a short timeout; on failure the server SHALL log a warning and fall back to the configured-provider models that have configured auth, without aborting the request. When LiteLLM is NOT configured, the server SHALL return models from the server's configured providers that have configured auth. Models SHALL be deduplicated by id. The list SHALL reflect the live proxy state so that models added through the LiteLLM admin UI appear without a server restart.

#### Scenario: client requests the model list (LiteLLM configured)
- **WHEN** a WebSocket client sends `{ "type": "list_models" }` and LiteLLM is configured
- **THEN** the server SHALL fetch `${LITELLM_BASE_URL}/v1/models` and reply with `{ "type": "models", "models": [ ... ] }` containing exactly the ids the proxy reports, each with `provider: "litellm"`
- **AND** SHALL deduplicate them by id

#### Scenario: LiteLLM proxy unreachable during list_models
- **WHEN** a WebSocket client sends `{ "type": "list_models" }` and the LiteLLM proxy is unreachable
- **THEN** the server SHALL log a warning and reply with models from configured providers that have configured auth
- **AND** SHALL NOT abort the request

#### Scenario: client requests the model list (no LiteLLM)
- **WHEN** a WebSocket client sends `{ "type": "list_models" }` and LiteLLM is NOT configured
- **THEN** the server SHALL reply with `{ "type": "models", "models": [ ... ] }` containing models from the server's configured providers that have configured auth
- **AND** SHALL deduplicate them by id
