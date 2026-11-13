## ADDED Requirements

### Requirement: Server lists available models to the client
The server SHALL respond to a `list_models` WebSocket message with the set of models available to the agent, each including its id, display name, and provider, sourced from the model registry's available models and scoped to the providers the server is configured to use.

#### Scenario: client requests the model list
- **WHEN** a WebSocket client sends `{ "type": "list_models" }`
- **THEN** the server SHALL reply with `{ "type": "models", "models": [ { "id": "...", "name": "...", "provider": "..." }, ... ] }` containing only models from the server's configured providers that have configured auth

### Requirement: Server communicates the active model
The server SHALL send the currently active model id to a client when its WebSocket connection opens, and SHALL send a `model_changed` event whenever the active model changes.

#### Scenario: client connects
- **WHEN** a WebSocket client establishes a connection
- **THEN** the server SHALL send `{ "type": "current_model", "id": "<active model id>" }`

#### Scenario: model is switched
- **WHEN** the active model changes from `glm-5.2` to `deepseek-v4-pro`
- **THEN** the server SHALL broadcast `{ "type": "model_changed", "id": "deepseek-v4-pro" }` to all clients

### Requirement: User can switch the active model at runtime
The server SHALL accept a `set_model` WebSocket message and switch the agent session's active model via the SDK's runtime model-switch API, validating that the requested model is available.

#### Scenario: user selects a valid model
- **WHEN** a client sends `{ "type": "set_model", "id": "deepseek-v4-flash" }` for a model in the available list
- **THEN** the server SHALL switch the session's active model and broadcast `model_changed` with the new id

#### Scenario: user selects an unknown model
- **WHEN** a client sends `{ "type": "set_model", "id": "nonexistent" }`
- **THEN** the server SHALL send an `error` message and the active model SHALL remain unchanged

### Requirement: Model switching is disabled while the agent is streaming
The server SHALL reject a `set_model` request while the agent is mid-response, so that a turn is not interrupted by a model switch.

#### Scenario: switch attempted during streaming
- **WHEN** a client sends `set_model` while the agent is streaming a response
- **THEN** the server SHALL send an `error` message indicating the model cannot be changed mid-turn
- **AND** SHALL NOT switch the model
