## MODIFIED Requirements

### Requirement: Server lists available models to the client
The server SHALL respond to a `list_models` WebSocket message with the set of models available to the agent, each including its id, display name, and provider, sourced from the model registry's available models. When LiteLLM is configured, the server SHALL ONLY include models routed through LiteLLM (models whose auth is the LiteLLM API key), excluding native Volces models from the client-facing list. Models SHALL be scoped to providers the server is configured to use, and SHALL have configured auth.

#### Scenario: client requests the model list (LiteLLM configured)
- **WHEN** a WebSocket client sends `{ "type": "list_models" }` and LiteLLM is configured
- **THEN** the server SHALL reply with `{ "type": "models", "models": [ ... ] }` containing ONLY LiteLLM-routed models (those with LiteLLM API key auth)
- **AND** SHALL deduplicate them by id

#### Scenario: client requests the model list (no LiteLLM)
- **WHEN** a WebSocket client sends `{ "type": "list_models" }` and LiteLLM is NOT configured
- **THEN** the server SHALL reply with `{ "type": "models", "models": [ ... ] }` containing models from the server's configured providers that have configured auth
- **AND** SHALL deduplicate them by id

---

### Requirement: Model selector is enabled as soon as models are known
The chat UI SHALL enable the model selector as soon as the available models are received, not only after the first agent turn completes. The selector SHALL be disabled while the agent is streaming and re-enabled when the turn ends (whether it succeeded or failed). The selector SHALL reflect the currently active model. The UI SHALL provide a command list popup showing available models as clickable items that trigger model selection.

#### Scenario: selector enabled on connect
- **WHEN** the page loads and the server sends the model list
- **THEN** the model selector SHALL be enabled
- **AND** SHALL reflect the currently active model

#### Scenario: selector re-enabled after a failed turn
- **WHEN** an agent turn ends with an error
- **THEN** the model selector SHALL be re-enabled

#### Scenario: model selection from command list
- **WHEN** the user opens the command list and clicks on a model name
- **THEN** the UI SHALL send a `set_model` message with the clicked model id
- **AND** SHALL reflect the new active model in the selector
