## MODIFIED Requirements

### Requirement: Server lists available models to the client
The server SHALL respond to a `list_models` WebSocket message with the set of models available to the agent, each including its id, display name, provider, and — when the model declares reasoning efforts in the generated dsh profile — a `reasoningEfforts` array of selectable thinking levels.

#### Scenario: client requests the model list
- **WHEN** a WebSocket client sends `{ "type": "list_models" }`
- **THEN** the server SHALL reply with `{ "type": "models", models: [...] }` where each entry includes `id`, `name`, `provider`, and an optional `reasoningEfforts: string[]` (absent or empty when the model offers no thinking-level control)

#### Scenario: non-reasoning model
- **WHEN** a model's generated profile declares `reasoningEfforts: false`
- **THEN** the `models` payload SHALL omit the `reasoningEfforts` field for that model
- **AND** the UI SHALL NOT render a thinking-level control for it

### Requirement: Server communicates the active model
The server SHALL send the currently active model id and thinking level to a client when its WebSocket connection opens, SHALL send a `model_changed` event whenever the active model changes, and SHALL send an `effort_changed` event whenever the thinking level changes.

#### Scenario: connect syncs effort
- **WHEN** a client's WebSocket connection opens
- **THEN** the server SHALL include the active `effort` in the ready-sync / `current_model` payload

#### Scenario: model switch invalidates effort
- **WHEN** the active model changes to one that does not support the persisted thinking level
- **THEN** the server SHALL fall back to the provider default and reflect the effective effort in the `model_changed` payload

## ADDED Requirements

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
The models page SHALL present the thinking-level picker alongside (not separate from) the model selector for models that declare efforts, and the chat header chip SHALL display the active model and non-default effort together.

#### Scenario: combined selector
- **WHEN** the user opens the models page and selects a model with declared efforts
- **THEN** the effort picker SHALL be offered in the same selection flow, with "Default" preselected when no explicit effort is persisted

#### Scenario: chip reflects effort
- **WHEN** a non-default thinking level is active
- **THEN** the Sidebar model chip SHALL display `Model · effort`
