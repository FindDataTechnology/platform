# user-runtime-bindings Specification

## Purpose
Provides identity-scoped model and MCP availability preferences for optional SSO users while preserving anonymous access and a shared dsh runtime.

## Requirements

### Requirement: Authenticated users can read personal runtime bindings

The server SHALL expose `GET /api/users/me/bindings` only to a request with a server-derived identity. In `AUTH_MODE=forward_auth`, the identity is the proxy-injected `req.user`; in optional SSO mode, it is the trusted proxy-injected SSO identity. A request body, query string, or browser-controlled header SHALL NOT select an email. The response SHALL include the personal model binding when present, otherwise the current global default with `source: "global"`, and one MCP entry for every globally configured server with `globalEnabled`, `personalEnabled`, `effectiveEnabled`, and `locked`. MCP URLs, headers, credentials, and complete configurations SHALL NOT be returned. A request without identity SHALL return `401`; a request when the database is unavailable SHALL return `503`.

#### Scenario: anonymous user cannot read bindings
- **WHEN** an anonymous client calls `GET /api/users/me/bindings`
- **THEN** the server returns `401`
- **AND** no binding data is returned

#### Scenario: authenticated user reads bindings
- **WHEN** a trusted SSO request for `dev@example.com` calls `GET /api/users/me/bindings`
- **THEN** the server returns that request's personal model binding state
- **AND** returns one MCP availability entry for each globally configured server
- **AND** the response contains no MCP URL, header, credential, or complete server configuration

#### Scenario: database unavailable
- **WHEN** the project database is unavailable while an authenticated user reads bindings
- **THEN** the server returns `503`
- **AND** anonymous chat and the shared runtime remain available

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

### Requirement: Authenticated users can save personal MCP availability

The server SHALL expose `PATCH /api/users/me/mcp/:name/enable` to an authenticated identity. The request body SHALL contain a boolean `enabled`. The named server MUST already exist in the global MCP configuration. The server SHALL persist only the identity, MCP name, and enabled value as a personal overlay; it SHALL NOT copy or modify the global MCP URL, headers, credentials, permissions, or configuration. A globally locked server SHALL NOT be disabled by a personal binding. The server SHALL request application of the effective MCP profile when the runtime is idle and SHALL return a pending state when it is busy.

#### Scenario: personal MCP toggle is saved
- **WHEN** an authenticated user enables or disables an existing non-locked global MCP server
- **THEN** the personal enabled value is persisted for that user
- **AND** the global MCP configuration remains unchanged

#### Scenario: locked MCP cannot be personally disabled
- **WHEN** an authenticated user attempts to disable a globally locked MCP server
- **THEN** the server returns an error
- **AND** no personal disabled binding is written

#### Scenario: globally disabled MCP cannot be personally enabled
- **WHEN** an authenticated user attempts to enable an MCP server that the administrator disabled globally
- **THEN** the server returns an error
- **AND** no personal binding is written, because a personal overlay can only withdraw availability, never grant what global configuration withholds

#### Scenario: unknown MCP cannot be bound
- **WHEN** an authenticated user references an MCP name that is not globally configured
- **THEN** the server returns an error
- **AND** no binding is written

#### Scenario: MCP toggle is pending while busy
- **WHEN** an authenticated user changes an MCP availability while the runtime is streaming
- **THEN** the personal value is persisted
- **AND** the response reports a pending application
- **AND** the current MCP tool set is not changed until the runtime is idle

### Requirement: Runtime bindings are cell-scoped state

In a hosted cell, per-user model bindings and MCP availability SHALL be stored in the cell's own database and SHALL take effect for that cell's runtime at cell start and on save, without an inter-user application protocol. The server SHALL NOT expose, in any response, another user's bindings or runtime state; within a cell there is exactly one binding scope (the cell's user), so `personalEnabled` overlays over a shared runtime's `globalEnabled` remain only for single-process non-cell modes.

#### Scenario: bindings apply at cell start
- **WHEN** a user's cell starts and that user has a saved model binding and MCP availability
- **THEN** the cell's runtime boots with that model
- **AND** the cell's MCP patch reflects that user's enabled/disabled servers

#### Scenario: no cross-user application machinery
- **WHEN** a user saves bindings in a hosted cell while any other user's cell exists
- **THEN** only the saving user's cell and runtime are involved in applying the change

### Requirement: WebSocket state is identity-aware without exposing other users

WebSocket identity SHALL be fixed from trusted headers at upgrade time and SHALL NOT be supplied by browser JavaScript. A socket with an identity SHALL receive its own `user_bindings` snapshot and binding-change events. A successful runtime profile application SHALL broadcast `runtime_binding` to all clients, and a deferred application SHALL broadcast `runtime_binding_pending`; neither event SHALL contain another user's email. Anonymous sockets SHALL receive only global runtime state. A login or sign-out SHALL close the old socket and establish a new socket so the next upgrade receives the correct fixed identity.

#### Scenario: owner receives personal snapshot
- **WHEN** an authenticated socket connects after the runtime is ready
- **THEN** it receives its own `user_bindings` snapshot

#### Scenario: profile change is global but owner-private data is not
- **WHEN** a personal profile changes the active runtime
- **THEN** all sockets receive `runtime_binding`
- **AND** no socket receives another user's email or personal binding payload

#### Scenario: anonymous socket receives global state only
- **WHEN** an anonymous socket connects
- **THEN** it receives the current model and MCP runtime state
- **AND** it does not receive a personal binding snapshot

#### Scenario: login changes WebSocket identity
- **WHEN** a browser obtains an SSO identity after an anonymous load
- **THEN** the browser closes the anonymous socket and opens a new socket
- **AND** the new socket receives the authenticated identity's bindings

### Requirement: Shared-runtime scope and credential boundaries remain explicit

Personal bindings SHALL affect only the selected model and the enabled/disabled availability of globally configured MCP servers. They SHALL NOT create per-user chat, document, session, workspace, credential, or MCP configuration isolation. The application SHALL NOT implement local passwords, Platform-owned sessions, or a user account table for this capability. Signing out SHALL NOT reset or restore the shared runtime profile. Optional SSO identity SHALL NOT grant administrator privileges.

#### Scenario: personal binding does not isolate chat data
- **WHEN** two authenticated users use the application with different bindings
- **THEN** each user's effective model and MCP availability can differ
- **AND** both users still use the shared chat sessions, documents, workspaces, and runtime process

#### Scenario: sign-out does not reset runtime
- **WHEN** the active user signs out while another client is using the application
- **THEN** the shared runtime profile remains active
- **AND** other clients continue using the current model and MCP tool set

#### Scenario: optional SSO is not administrator access
- **WHEN** an optional SSO identity has an `admin` group header
- **THEN** the identity can use personal binding endpoints
- **AND** it cannot perform administrator-only global mutations unless the existing forward-auth administrator authorization also applies
