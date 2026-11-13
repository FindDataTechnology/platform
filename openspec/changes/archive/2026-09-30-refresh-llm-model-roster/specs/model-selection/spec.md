## MODIFIED Requirements

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
