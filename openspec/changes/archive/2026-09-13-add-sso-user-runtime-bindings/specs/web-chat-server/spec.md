## MODIFIED Requirements

### Requirement: Server creates and manages a dsh agent session

The server SHALL create a single agent session on startup by spawning the dsh runtime as a subprocess and establishing a JSON-RPC session over stdio (see `dsh-runtime-bridge`). The session SHALL be in-memory and equipped with the dsh-profile tools (`dsh-tool-bash`, `dsh-tool-fs`, `dsh-mcp-client`). When no chat provider is configured, the server SHALL still spawn the runtime and start successfully (chat non-functional, logged) rather than exiting — see "Server degrades gracefully when no chat provider is configured". The single shared session SHALL have one effective runtime profile composed from global configuration and, when applied, an authenticated user's personal model and MCP availability bindings. The profile coordinator SHALL not preempt an in-flight response; it SHALL retain a different requested profile as pending until the runtime is idle.

#### Scenario: Server starts successfully
- **WHEN** the server starts with a valid API key configured and the dsh binary discoverable
- **THEN** the dsh runtime SHALL be spawned with a profile composing bash, fs, grep, find, ls, and MCP tools and an in-memory session

#### Scenario: User sends a prompt
- **WHEN** a WebSocket client sends `{ "type": "prompt", "text": "List files" }`
- **THEN** the server forwards the prompt to the dsh runtime via JSON-RPC and streams the translated response back

#### Scenario: User sends prompt while agent is streaming
- **WHEN** a WebSocket client sends a prompt while the agent is already processing
- **THEN** the server SHALL queue the prompt using `steer` behavior or reject it, preserving the existing streaming guard

#### Scenario: Personal profile waits for an in-flight response
- **WHEN** an authenticated user requests a different effective runtime profile while a prompt is streaming
- **THEN** the response continues to completion
- **AND** the requested profile is retained as pending
- **AND** the profile is applied only after the runtime becomes idle

## ADDED Requirements

### Requirement: Shared runtime profile changes are synchronized over WebSocket

The server SHALL expose WebSocket events that distinguish the active shared runtime profile from an identity's private binding state. `runtime_binding` SHALL be broadcast after a successful profile application; `runtime_binding_pending` SHALL be broadcast when a requested profile cannot be applied immediately. These events SHALL include the effective model and MCP availability state needed by the UI but SHALL NOT include an email. A socket with a trusted identity SHALL additionally receive its own `user_bindings` snapshot. Anonymous sockets SHALL receive global runtime state without a personal snapshot.

#### Scenario: clients observe an applied profile
- **WHEN** a personal profile is applied to the shared runtime
- **THEN** all connected clients receive `runtime_binding` with the effective model and MCP availability

#### Scenario: clients observe a deferred profile
- **WHEN** a personal profile is requested while the runtime is busy
- **THEN** clients receive `runtime_binding_pending`
- **AND** the event does not contain the requesting user's email

#### Scenario: authenticated client receives private state
- **WHEN** an authenticated client connects
- **THEN** it receives its own `user_bindings` snapshot in addition to global runtime state
