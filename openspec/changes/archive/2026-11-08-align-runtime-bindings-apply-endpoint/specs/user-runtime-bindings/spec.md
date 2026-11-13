# user-runtime-bindings 补端点契约

## MODIFIED Requirements

### Requirement: Runtime bindings are cell-scoped state

In a hosted cell, per-user model bindings and MCP availability SHALL be stored in the cell's own database and SHALL take effect for that cell's runtime at cell start and on save, without an inter-user application protocol. The server SHALL NOT expose, in any response, another user's bindings or runtime state; within a cell there is exactly one binding scope (the cell's user), so `personalEnabled` overlays over a shared runtime's `globalEnabled` remain only for single-process non-cell modes.

One endpoint survives from before the cell change and is part of the contract:
`POST /api/users/me/bindings/apply` (exported to SDK consumers as `applyBindings`)
re-applies the caller's own persisted bindings to the runtime on demand — a
repair lever for a cell whose runtime drifted from its stored binding, and the
way a client retries an application that a streaming turn deferred. It reads
only the caller's own persisted bindings; it accepts no body fields, so it
cannot write a binding. Its answer is one of three states: applied (`ok`),
deferred because the runtime is busy (`pending`, with the application queued
and a `runtime_binding_pending` broadcast), or failed with a reason (the
previous runtime profile stays active).

#### Scenario: bindings apply at cell start

- **WHEN** a user's cell starts and that user has a saved model binding and MCP availability
- **THEN** the cell's runtime boots with that model
- **AND** the cell's MCP patch reflects that user's enabled/disabled servers

#### Scenario: no cross-user application machinery

- **WHEN** a user saves bindings in a hosted cell while any other user's cell exists
- **THEN** only the saving user's cell and runtime are involved in applying the change

#### Scenario: a deferred application is retried on demand

- **WHEN** an authenticated user calls `POST /api/users/me/bindings/apply`
- **THEN** the server re-applies that user's persisted bindings to their runtime, without accepting any binding value in the request
- **AND** while the runtime is streaming it answers pending, queues the application, and broadcasts `runtime_binding_pending`
- **AND** a failed application leaves the previous runtime profile active and reports the reason rather than claiming success
