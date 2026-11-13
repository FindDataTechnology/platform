## MODIFIED Requirements

### Requirement: Server lists available models to the client

The server SHALL respond to a `list_models` WebSocket message with the set of models available to the agent, each including its id, display name, and provider. The model list SHALL be sourced from the dsh runtime's reported models (requested over the JSON-RPC bridge) rather than the pi `ModelRegistry`, and scoped to the providers the server is configured to use (Volces and/or LiteLLM adapters). When LiteLLM is configured, LiteLLM-routed models SHALL be included and correctly identified.

#### Scenario: client requests the model list

- **WHEN** a WebSocket client sends `{ "type": "list_models" }`
- **THEN** the server SHALL request the model list from the dsh runtime over JSON-RPC
- **AND** SHALL reply with `{ "type": "models", "models": [ { "id": "...", "name": "...", "provider": "..." }, ... ] }` containing only models from the server's configured adapters that have configured auth

#### Scenario: LiteLLM models appear in selector when configured

- **WHEN** the server starts with LiteLLM configured
- **AND** a client sends `{ "type": "list_models" }`
- **THEN** the server SHALL include LiteLLM-routed models in the `models` response
- **AND** the model selector dropdown SHALL display LiteLLM models as selectable options

### Requirement: Server communicates the active model

The server SHALL send the currently active model id to a client when its WebSocket connection opens, and SHALL send a `model_changed` event whenever the active model changes. The active model SHALL be tracked as the dsh runtime's current model, queried/set over the JSON-RPC bridge.

#### Scenario: client connects

- **WHEN** a WebSocket client establishes a connection
- **THEN** the server SHALL send `{ "type": "current_model", "id": "<active model id>" }`

#### Scenario: model is switched

- **WHEN** the active model changes from `glm-5.2` to `deepseek-v4-pro`
- **THEN** the server SHALL broadcast `{ "type": "model_changed", "id": "deepseek-v4-pro" }` to all clients

### Requirement: User can switch the active model at runtime

The server SHALL accept a `set_model` WebSocket message OR a `/model <id>` chat command and switch the dsh runtime's active model via a JSON-RPC model-switch request over the bridge, validating that the requested model is available and has configured auth. A `/model` command with no argument SHALL report the currently active model AND list all available selectable models. The switched model SHALL apply to the next agent turn. (Model switching is rejected while the agent is streaming, per the dedicated streaming-guard requirement.)

#### Scenario: user selects a valid model via the selector

- **WHEN** a client sends `{ "type": "set_model", "id": "deepseek-v4-flash" }` for a model in the available list
- **THEN** the server SHALL send a JSON-RPC model-switch request to the dsh runtime
- **AND** SHALL broadcast `model_changed` with the new id

#### Scenario: user switches model via the /model command

- **WHEN** a client sends `{ "type": "prompt", "text": "/model deepseek-v4-pro" }` for a model in the available list
- **THEN** the server SHALL switch the dsh runtime's active model and broadcast `model_changed` with the new id
- **AND** SHALL broadcast a `command_use` event for the `model` command

#### Scenario: /model with no argument reports current model and lists available models

- **WHEN** a client sends `{ "type": "prompt", "text": "/model" }`
- **THEN** the server SHALL broadcast a `command_use` event reporting the currently active model
- **AND** SHALL include a list of all available selectable models in the message
- **AND** SHALL NOT switch the model

#### Scenario: user selects an unknown model

- **WHEN** a client sends `set_model` or `/model nonexistent` for a model not in the available list
- **THEN** the server SHALL send an `error` message and the active model SHALL remain unchanged
