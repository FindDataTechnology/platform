# model-selection Specification

## Purpose
TBD - created by archiving change add-mcp-skills-model-select. Update Purpose after archive.

## Requirements


### Requirement: Server lists available models to the client

The server SHALL respond to a `list_models` WebSocket message with the set of models available to the agent, each including its id, display name, provider, and — when the model declares reasoning efforts in the generated dsh profile — a `reasoningEfforts` array of selectable thinking levels. The model list SHALL be sourced from the dsh runtime's reported models (requested over the JSON-RPC bridge) rather than the pi `ModelRegistry`, and scoped to the providers the server is configured to use. When more than one configured provider's roster lists the same model id, the server SHALL return exactly one entry for that id (first roster occurrence wins), so clients never receive duplicate ids from merged providers.

#### Scenario: client requests the model list

- **WHEN** a WebSocket client sends `{ "type": "list_models" }`
- **THEN** the server SHALL request the model list from the dsh runtime over JSON-RPC
- **AND** SHALL reply with `{ "type": "models", "models": [ { "id": "...", "name": "...", "provider": "..." }, ... ] }` containing only models from the server's configured adapters that have configured auth
- **AND** each entry SHALL include an optional `reasoningEfforts: string[]` (absent or empty when the model offers no thinking-level control)

#### Scenario: non-reasoning model

- **WHEN** a model's generated profile declares `reasoningEfforts: false`
- **THEN** the `models` payload SHALL omit the `reasoningEfforts` field for that model
- **AND** the UI SHALL NOT render a thinking-level control for it

#### Scenario: same model id on two provider rosters

- **WHEN** the env-generated provider route and a user-managed provider both declare a model with the same id
- **THEN** the `models` payload SHALL contain exactly one entry for that id, carrying the first-occurring roster's provider attribution
- **AND** client model pickers keyed by model id SHALL NOT render duplicate rows or encounter key collisions

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

### Requirement: Model switching is disabled while the agent is streaming
The server SHALL reject a `set_model` request while the agent is mid-response, so that a turn is not interrupted by a model switch.

#### Scenario: switch attempted during streaming
- **WHEN** a client sends `set_model` while the agent is streaming a response
- **THEN** the server SHALL send an `error` message indicating the model cannot be changed mid-turn
- **AND** SHALL NOT switch the model

### Requirement: Server selects a default model at startup
The server SHALL select a default model when creating the agent session by passing an explicit model to the runtime. If the `DEFAULT_MODEL` environment variable is set and matches an available model id, that model SHALL be used. Otherwise the first available model with configured auth SHALL be used. The selected default model SHALL be communicated to clients as the active model on connect. The model selector SHALL list models with configured auth, deduplicated by id. The startup selection SHALL pass through the default-lane guard: if the resolved default is probed definitively dark at boot, the guard's fallback applies before the session serves its first turn.

#### Scenario: DEFAULT_MODEL overrides the default
- **WHEN** the server starts with `DEFAULT_MODEL` set to a valid available model id
- **THEN** the agent session SHALL start on that model
- **AND** the `current_model` sent on connect SHALL be that model's id

#### Scenario: first available model is the default
- **WHEN** the server starts with `DEFAULT_MODEL` unset
- **THEN** the agent session SHALL start on the first available model with configured auth
- **AND** the `current_model` sent on connect SHALL be that model's id

#### Scenario: available models are deduplicated
- **WHEN** a client sends `{ "type": "list_models" }`
- **THEN** the server SHALL include every model with configured auth in the `models` response
- **AND** SHALL deduplicate them by id

### Requirement: Default model lane is guarded against dark defaults
The platform SHALL verify that the default model actually serves before relying on it: at agent-session boot, after a provider sync completes, and after a default-pointer change. Verification SHALL be a single minimal chat completion against the default model. When the probe returns a definitive dark answer (`model_not_found` or an unauthorized-class client error), the platform SHALL switch the default pointer to the first model known to be serving (per the most recent sync classification, in roster order), apply the substitution through the hot-reload path, and broadcast a `model_fallback` event carrying the old and new model ids so connected clients and the Models page surface the substitution. When the probe fails with a network error or timeout, the platform SHALL keep the configured default unchanged (a flapping gateway SHALL NOT silently move the default). The probe error string SHALL be sanitized before any persistence or broadcast.

#### Scenario: dark default at boot falls back

- **WHEN** the server boots with the resolved default model answering the verification probe with `model_not_found`
- **THEN** the default pointer SHALL switch to the first known-serving model before the first turn is served
- **AND** a `model_fallback` event SHALL broadcast the old and new model ids

#### Scenario: network error does not trigger fallback

- **WHEN** the verification probe fails with a timeout or connection error
- **THEN** the configured default SHALL remain in effect
- **AND** no `model_fallback` event SHALL be broadcast

#### Scenario: guard runs after sync and default changes

- **WHEN** a provider sync completes, or an admin changes the default pointer, and the new default is classified other than `serving`
- **THEN** the platform SHALL apply the same fallback and broadcast semantics as at boot
- **AND** the Models page SHALL surface the substitution to the admin who made the change

#### Scenario: no serving model exists

- **WHEN** the guard needs to fall back but no model is known to be serving
- **THEN** the configured default SHALL remain in effect and the failure SHALL be surfaced (status surface and logs) rather than silently selecting an unverified model

### Requirement: Model selector is enabled as soon as models are known
The chat UI SHALL enable the model selector as soon as the available models are received, not only after the first agent turn completes. The selector SHALL be disabled while the agent is streaming and re-enabled when the turn ends (whether it succeeded or failed). The selector SHALL reflect the currently active model. The UI SHALL provide a command list popup showing available models as clickable items that trigger model selection. The click handler SHALL safely check for null DOM references before accessing properties.

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

### Requirement: Model selector input click does not throw errors
Clicking on the model selector input SHALL open the dropdown and SHALL NOT throw JavaScript errors. The click handler SHALL properly handle null or undefined references and ensure the dropdown state is managed correctly.

#### Scenario: clicking model selector opens dropdown
- **WHEN** user clicks on the model selector input
- **THEN** the model dropdown SHALL open
- **AND** no JavaScript error SHALL be thrown

#### Scenario: model selector shows current model
- **WHEN** the page loads and the current model is received
- **THEN** the model selector SHALL display the current model id
- **AND** the input SHALL not be empty

### Requirement: Client can switch the thinking level
The server SHALL accept a `set_effort` WebSocket message carrying a thinking level, validate it against the current model's declared `reasoningEfforts`, persist it host-side, write it into the dsh settings profile, and apply it by restarting the dsh runtime (which resumes the session from disk).

#### Scenario: supported level selected
- **WHEN** the client sends `{ "type": "set_effort", "effort": "high" }` while the current model declares `high`
- **THEN** the server SHALL persist the level, update the generated `llm-pi-ai` profile, restart the dsh runtime, and broadcast `effort_changed { effort: "high" }`

#### Scenario: unsupported level rejected
- **WHEN** the client sends `set_effort` with a level not declared for the current model
- **THEN** the server SHALL reply with an error and SHALL NOT restart the runtime or alter persistence

#### Scenario: switch rejected while streaming
- **WHEN** the agent is streaming a turn and `set_effort` arrives
- **THEN** the server SHALL reject the switch with an error, matching the existing model-switch guard

### Requirement: Model and thinking level are selected together in the UI
The Settings Models section (`/settings/models`) SHALL present the thinking-level picker alongside (not separate from) the model selector for models that declare efforts, and the composer control strip SHALL display the active model and its non-default effort in adjacent controls so that the pair reads as one setting.

#### Scenario: combined selector
- **WHEN** the user opens the Settings Models section and selects a model with declared efforts
- **THEN** the effort picker SHALL be offered in the same selection flow, with "Default" preselected when no explicit effort is persisted

#### Scenario: strip reflects effort
- **WHEN** a non-default thinking level is active
- **THEN** the control strip's model control SHALL display the active model
- **AND** the adjacent reasoning-effort control SHALL display the active effort

#### Scenario: legacy models route resolves
- **WHEN** the user navigates to `/models`
- **THEN** the router SHALL redirect to `/settings/models`
- **AND** the Settings surface SHALL open on the Models section

### Requirement: Personal model binding can determine the effective runtime model

An authenticated user's saved personal model binding SHALL participate in the shared runtime's effective profile. When the runtime is idle, the profile coordinator SHALL apply the binding and restart the dsh runtime with its provider/model pair. When the runtime is busy, the binding SHALL be persisted and marked pending until the runtime becomes idle. The binding SHALL be validated against the same available model roster used by model selection, and a failed restart SHALL leave the previous runtime model active.

#### Scenario: saved binding applies on reconnect
- **WHEN** an authenticated user reconnects with a saved personal model binding and the runtime is idle
- **THEN** the runtime applies that model before reporting the connected profile

#### Scenario: saved binding applies after a busy turn
- **WHEN** a saved personal model binding is pending while a turn is streaming
- **THEN** the binding is applied after the turn completes
- **AND** the client receives the resulting model state
