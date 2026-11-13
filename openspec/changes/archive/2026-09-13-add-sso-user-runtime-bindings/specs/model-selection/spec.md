## MODIFIED Requirements

### Requirement: Server communicates the active model

The server SHALL send the currently active model id and thinking level to a client when its WebSocket connection opens, SHALL send a `model_changed` event whenever the active model changes, and SHALL send an `effort_changed` event whenever the thinking level changes. The active model is the model in the shared dsh runtime's effective profile, which may be selected by an authenticated user's personal binding when that profile is applied. The server SHALL track the active model as the dsh runtime's current model, queried/set over the JSON-RPC bridge. A personal binding application SHALL update the effective profile without exposing the user's email in the model event.

#### Scenario: client connects
- **WHEN** a WebSocket client establishes a connection
- **THEN** the server SHALL send `{ "type": "current_model", "id": "<active model id>" }`

#### Scenario: connect syncs effort
- **WHEN** a client's WebSocket connection opens
- **THEN** the server SHALL include the active `effort` in the ready-sync / `current_model` payload

#### Scenario: model is switched
- **WHEN** the active model changes from `glm-5.2` to `deepseek-v4-pro`
- **THEN** the server SHALL broadcast `{ "type": "model_changed", "id": "deepseek-v4-pro" }` to all clients

#### Scenario: personal profile changes the active model
- **WHEN** an authenticated user's personal model binding is applied to the shared runtime
- **THEN** the server SHALL broadcast the resulting active model to all clients
- **AND** the event SHALL NOT contain the user's email

#### Scenario: model switch invalidates effort
- **WHEN** the active model changes to one that does not support the persisted thinking level
- **THEN** the server SHALL fall back to the provider default and reflect the effective effort in the `model_changed` payload

### Requirement: User can switch the active model at runtime

The server SHALL accept a `set_model` WebSocket message OR a `/model <id>` chat command and switch the dsh runtime's active model via a JSON-RPC model-switch request over the bridge, validating that the requested model is available and has configured auth. A `/model` command with no argument SHALL report the currently active model AND list all available selectable models. The switched model SHALL apply to the next agent turn. Saving a personal model binding is a separate authenticated REST operation and SHALL NOT be implied by an explicit `set_model` or `/model` command. Runtime profile application and explicit model switching SHALL share the streaming guard and SHALL NOT interrupt an in-flight response.

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

#### Scenario: personal model save is separate from model selection
- **WHEN** an authenticated user sends `set_model` without calling the personal binding endpoint
- **THEN** the runtime model changes as an explicit global selection
- **AND** no personal model binding is created or updated

## ADDED Requirements

### Requirement: Personal model binding can determine the effective runtime model

An authenticated user's saved personal model binding SHALL participate in the shared runtime's effective profile. When the runtime is idle, the profile coordinator SHALL apply the binding and restart the dsh runtime with its provider/model pair. When the runtime is busy, the binding SHALL be persisted and marked pending until the runtime becomes idle. The binding SHALL be validated against the same available model roster used by model selection, and a failed restart SHALL leave the previous runtime model active.

#### Scenario: saved binding applies on reconnect
- **WHEN** an authenticated user reconnects with a saved personal model binding and the runtime is idle
- **THEN** the runtime applies that model before reporting the connected profile

#### Scenario: saved binding applies after a busy turn
- **WHEN** a saved personal model binding is pending while a turn is streaming
- **THEN** the binding is applied after the turn completes
- **AND** the client receives the resulting model state
