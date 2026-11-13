## ADDED Requirements

### Requirement: Backend API for managing MCP servers at runtime
The server SHALL expose REST API endpoints to list, add, remove, enable, and disable MCP servers without requiring a server restart.

#### Scenario: list MCP servers via API
- **WHEN** client sends GET `/api/extensions/mcp`
- **THEN** the server SHALL return a list of all configured MCP servers with their name, config, status (connected/disconnected), enabled state, and tool count

#### Scenario: add MCP server via API
- **WHEN** client sends POST `/api/extensions/mcp` with server config (name, command/args or url, headers, env)
- **THEN** the server SHALL persist the config, connect to the server, register its tools, and return success

#### Scenario: remove MCP server via API
- **WHEN** client sends DELETE `/api/extensions/mcp/:name`
- **THEN** the server SHALL disconnect from the server, unregister its tools, remove the config, and return success

#### Scenario: enable/disable MCP server via API
- **WHEN** client sends PATCH `/api/extensions/mcp/:name` with `{ "enabled": false }`
- **THEN** the server SHALL disconnect from the server, unregister its tools, mark it disabled, and return success
- **WHEN** client sends PATCH `/api/extensions/mcp/:name` with `{ "enabled": true }`
- **THEN** the server SHALL connect to the server, register its tools, mark it enabled, and return success

### Requirement: Backend API for managing skills at runtime
The server SHALL expose REST API endpoints to list, add, remove, enable, and disable skills without requiring a server restart.

#### Scenario: list skills via API
- **WHEN** client sends GET `/api/extensions/skills`
- **THEN** the server SHALL return a list of all skills with their name, description, source (built-in/custom), and enabled state

#### Scenario: add custom skill via API
- **WHEN** client sends POST `/api/extensions/skills` with skill definition (name, description, body)
- **THEN** the server SHALL persist the skill, register it with the agent, and return success

#### Scenario: remove custom skill via API
- **WHEN** client sends DELETE `/api/extensions/skills/:name`
- **THEN** the server SHALL unregister the skill, remove its definition, and return success
- **AND** built-in skills SHALL NOT be removable (return 400)

#### Scenario: enable/disable skill via API
- **WHEN** client sends PATCH `/api/extensions/skills/:name` with `{ "enabled": false }`
- **THEN** the server SHALL unregister the skill from the agent, mark it disabled, and return success
- **WHEN** client sends PATCH `/api/extensions/skills/:name` with `{ "enabled": true }`
- **THEN** the server SHALL register the skill with the agent, mark it enabled, and return success

### Requirement: Hot-reload MCP connections on config change
The server SHALL support connecting to new MCP servers and disconnecting from existing ones at runtime, updating the agent's available tools without restarting.

#### Scenario: new MCP server connected at runtime
- **WHEN** an MCP server is added via API
- **THEN** the server SHALL establish a connection, discover its tools, register them as `ToolDefinition`s, and update the agent's tool allowlist
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

#### Scenario: MCP server disconnected at runtime
- **WHEN** an MCP server is removed or disabled via API
- **THEN** the server SHALL close the connection, unregister its tools from the agent's tool allowlist
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

### Requirement: Hot-reload skill registrations on config change
The server SHALL support registering and unregistering skills at runtime, updating the agent's available skills without restarting.

#### Scenario: new skill registered at runtime
- **WHEN** a skill is added or enabled via API
- **THEN** the server SHALL load the skill into the agent's skill registry
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

#### Scenario: skill unregistered at runtime
- **WHEN** a skill is removed or disabled via API
- **THEN** the server SHALL remove the skill from the agent's skill registry
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

### Requirement: MCP and skill configs persist across restarts
The server SHALL persist MCP server configurations and custom skill definitions so they survive server restarts.

#### Scenario: MCP server config persistss
- **WHEN** an MCP server is added via API and the server restarts
- **THEN** the server SHALL reconnect to that MCP server on startup

#### Scenario: custom skill persists
- **WHEN** a custom skill is added via API and the server restarts
- **THEN** the server SHALL reload that skill on startup
