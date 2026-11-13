# user-runtime-bindings Specification

## MODIFIED Requirements

### Requirement: Authenticated users can save a personal model binding

The server SHALL expose `PUT /api/users/me/model` to an authenticated identity. The request body SHALL contain `providerId` and `modelId`; the server SHALL validate that the pair is present in the configured available model list, normalize the identity email, and persist the pair as that identity's model binding. Saving a personal binding SHALL NOT change the global default model or provider configuration. In a hosted cell the saved binding SHALL apply to the cell's own runtime as the global model-selection path does — the cell's single user is the runtime's only owner — and a binding saved while the runtime is streaming SHALL be applied when the current turn completes. An unknown or unavailable model SHALL be rejected without changing persistence.

#### Scenario: valid model is saved
- **WHEN** an authenticated user saves an available `{ "providerId": "...", "modelId": "..." }` pair
- **THEN** the pair is persisted for that user's normalized email
- **AND** the global default model remains unchanged

#### Scenario: model is applied while idle
- **WHEN** a saved personal model is applied while the user's runtime is idle
- **THEN** that user's runtime restarts with the selected provider and model
- **AND** that user's clients receive the resulting active model state
- **AND** no other user's runtime is affected

#### Scenario: model is saved while busy
- **WHEN** an authenticated user saves a valid model while their runtime is streaming
- **THEN** the binding is persisted
- **AND** the response reports that application follows the current turn's completion
- **AND** the in-flight response is not interrupted

#### Scenario: invalid model is rejected
- **WHEN** an authenticated user submits a model pair that is not available
- **THEN** the server returns an error
- **AND** no personal model binding is written

## ADDED Requirements

### Requirement: Runtime bindings are cell-scoped state

In a hosted cell, per-user model bindings and MCP availability SHALL be stored in the cell's own database and SHALL take effect for that cell's runtime at cell start and on save, without an inter-user application protocol. The server SHALL NOT expose, in any response, another user's bindings or runtime state; within a cell there is exactly one binding scope (the cell's user), so `personalEnabled` overlays over a shared runtime's `globalEnabled` remain only for single-process non-cell modes.

#### Scenario: bindings apply at cell start
- **WHEN** a user's cell starts and that user has a saved model binding and MCP availability
- **THEN** the cell's runtime boots with that model
- **AND** the cell's MCP patch reflects that user's enabled/disabled servers

#### Scenario: no cross-user application machinery
- **WHEN** a user saves bindings in a hosted cell while any other user's cell exists
- **THEN** only the saving user's cell and runtime are involved in applying the change

## REMOVED Requirements

### Requirement: Personal profiles apply to the shared runtime without preemption

**Reason**: the shared-runtime model is superseded by per-user cells; in a cell the single user owns the runtime, so busy-window pending applications, runtime-owner tracking, and overlay application between users have no object to act on.
