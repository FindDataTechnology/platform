## MODIFIED Requirements

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

## ADDED Requirements

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
