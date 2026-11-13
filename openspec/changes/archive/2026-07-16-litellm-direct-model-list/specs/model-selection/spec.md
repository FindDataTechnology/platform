## MODIFIED Requirements

### Requirement: Server lists available models to the client
The server SHALL respond to a `list_models` WebSocket message with the set of models available. When LiteLLM is configured, the server SHALL fetch models directly from the LiteLLM proxy's `/v1/models` endpoint and return them. When LiteLLM is not configured or the fetch fails, the server SHALL fall back to the model registry's available models, scoped to providers with configured auth.

#### Scenario: client requests the model list (LiteLLM configured)
- **WHEN** a WebSocket client sends `{ type: "list_models" }` and LiteLLM is configured
- **THEN** the server SHALL fetch `${LITELLM_BASE_URL}/v1/models` with the LiteLLM API key
- **AND** SHALL return the model list mapped to `{ id, name, provider }` format

#### Scenario: client requests the model list (no LiteLLM)
- **WHEN** a WebSocket client sends `{ type: "list_models" }` and LiteLLM is NOT configured
- **THEN** the server SHALL fall back to the model registry behavior

#### Scenario: LiteLLM fetch fails
- **WHEN** LiteLLM is configured but the `/v1/models` fetch fails
- **THEN** the server SHALL fall back to the model registry behavior
- **AND** SHALL log a warning
