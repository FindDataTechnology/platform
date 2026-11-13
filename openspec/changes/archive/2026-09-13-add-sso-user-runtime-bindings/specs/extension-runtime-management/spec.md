## MODIFIED Requirements

### Requirement: Backend API for managing MCP servers at runtime

The server SHALL expose REST API endpoints to list, add, remove, enable, and disable MCP servers without requiring a server restart. Each listed server SHALL include its `origin` (`bundled` or `user`) and `locked` flag. Servers marked `locked` (packager-locked bundled entries) SHALL NOT be removable, disable-able, or config-editable via the API: such requests SHALL return 400 with an explanatory error. When authentication is enabled, these global mutation endpoints SHALL require the existing administrator group authorization; optional SSO identity alone SHALL NOT satisfy that authorization. Global mutations SHALL modify the global MCP configuration store, while personal availability toggles SHALL use the separate identity-scoped binding endpoints and SHALL NOT modify this store.

#### Scenario: list MCP servers via API
- **WHEN** client sends GET `/api/extensions/mcp`
- **THEN** the server SHALL return a list of all configured MCP servers with their name, config, status (connected/disconnected), enabled state, tool count, origin, and locked flag

#### Scenario: add MCP server via API
- **WHEN** an authorized administrator sends POST `/api/extensions/mcp` with server config (name, command/args or url, headers, env)
- **THEN** the server SHALL persist the config (with `origin: "user"`), connect to the server, register its tools, and return success

#### Scenario: non-admin cannot mutate global MCP configuration
- **WHEN** authentication is enabled and a non-admin user sends a global MCP mutation
- **THEN** the server returns `403`
- **AND** the global configuration remains unchanged

#### Scenario: remove MCP server via API
- **WHEN** an authorized administrator sends DELETE `/api/extensions/mcp/:name`
- **THEN** the server SHALL disconnect from the server, unregister its tools, remove the config, and return success
- **WHEN** the named server is locked
- **THEN** the server SHALL return 400 and leave the entry untouched

#### Scenario: enable/disable MCP server via API
- **WHEN** an authorized administrator sends PATCH `/api/extensions/mcp/:name` with `{ "enabled": false }`
- **THEN** the server SHALL disconnect from the server, unregister its tools, mark it disabled, and return success
- **WHEN** an authorized administrator sends PATCH `/api/extensions/mcp/:name` with `{ "enabled": true }`
- **THEN** the server SHALL connect to the server, register its tools, mark it enabled, and return success
- **WHEN** the named server is locked
- **THEN** enable/disable and config-update requests SHALL return 400 and leave the entry untouched

### Requirement: Hot-reload MCP connections on config change

The server SHALL support connecting to new MCP servers and disconnecting from existing ones at runtime, updating the agent's available tools without restarting. Global add/remove/enable/disable mutations SHALL update the global configuration and trigger the normal hot-reload path. A personal MCP availability binding SHALL update only the effective runtime overlay when applied; it SHALL use the same serialized hot-reload path but SHALL NOT alter the global configuration or its enabled flag.

#### Scenario: new MCP server connected at runtime
- **WHEN** an MCP server is added via API
- **THEN** the server SHALL establish a connection, discover its tools, register them as `ToolDefinition`s, and update the agent's tool allowlist
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

#### Scenario: MCP server disconnected at runtime
- **WHEN** an MCP server is removed or disabled via API
- **THEN** the server SHALL close the connection, unregister its tools from the agent's tool allowlist
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

#### Scenario: personal MCP availability reloads without global mutation
- **WHEN** an authenticated user's effective MCP overlay changes while the runtime is idle
- **THEN** the runtime hot-reloads the effective tool set
- **AND** `GET /api/extensions/mcp` still reports the unchanged global enabled state

## ADDED Requirements

### Requirement: Personal MCP availability is a separate management operation

The server SHALL expose an authenticated personal MCP availability endpoint that accepts an existing global MCP name and a boolean enabled value. The endpoint SHALL persist an email-keyed overlay, reject unknown names and attempts to disable locked servers, and apply the resulting effective profile through the shared runtime coordinator. The endpoint SHALL never expose or persist MCP URLs, headers, credentials, permissions, or complete configurations.

#### Scenario: personal toggle is authorized
- **WHEN** an authenticated user toggles an existing non-locked MCP server
- **THEN** the personal overlay is saved
- **AND** the global MCP record is unchanged

#### Scenario: personal toggle is rejected for a locked server
- **WHEN** an authenticated user attempts to disable a locked MCP server
- **THEN** the server returns an error
- **AND** the server remains enabled in the effective profile
