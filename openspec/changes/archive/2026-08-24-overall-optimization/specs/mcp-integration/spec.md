## MODIFIED Requirements

### Requirement: MCP server tools are registered as agent-callable custom tools
The server SHALL declare each MCP server as a `dsh-mcp-client` loader entry in the watched patch file so that dsh discovers each server's tools via `listTools()` and registers them as agent-callable tools (naming convention `mcp__<serverName>__<toolName>`), so the agent can invoke MCP tools identically to built-in tools. When MCP server configurations change at runtime (add/remove/enable/disable), the server SHALL update the tool registry by writing the affected entries **in place** into the watched patch file, letting `dsh-mcp-client` hot-swap (disconnect the affected server and reconnect) **without restarting the dsh process**. If the in-place hot-swap path is unavailable (the watched overlay is not HMR-watched), the server SHALL fall back to a serialized `restart()`.

#### Scenario: MCP tool is callable by the agent
- **WHEN** a connected MCP server exposes a tool `search`
- **THEN** the agent session SHALL have a `search` tool available with the MCP tool's `inputSchema` as its parameter schema
- **AND** when the agent calls `search`, the call SHALL be forwarded to the MCP server and the result returned to the agent

#### Scenario: MCP tool parameter schema is preserved
- **WHEN** an MCP tool declares an `inputSchema` with required properties
- **THEN** the registered tool SHALL carry that schema so the agent is informed of the expected parameters

#### Scenario: MCP server added at runtime
- **WHEN** a new MCP server is added via the management API
- **THEN** the server SHALL write the new entry into the watched patch file in place
- **AND** dsh-mcp-client SHALL hot-swap to connect to it, discover its tools, and register them in the agent's tool registry
- **AND** the newly registered tools SHALL be immediately available to the agent without a process restart

#### Scenario: MCP server removed at runtime
- **WHEN** an MCP server is removed via the management API
- **THEN** the server SHALL remove the entry from the watched patch file in place
- **AND** dsh-mcp-client SHALL disconnect from it and unregister its tools from the agent's tool registry
- **AND** the removed tools SHALL no longer be available to the agent without a process restart

#### Scenario: MCP server disabled at runtime
- **WHEN** an MCP server is disabled via the management API
- **THEN** the server SHALL preserve the configuration so it can be re-enabled later
- **AND** dsh-mcp-client SHALL disconnect from it and unregister its tools without a process restart

#### Scenario: hot-swap unavailable falls back to serialized restart
- **WHEN** the in-place patch-file hot-swap path is unavailable (the watched overlay is not HMR-watched)
- **THEN** the server SHALL fall back to a serialized restart that re-spawns the dsh child with the updated patch
- **AND** concurrent mutations SHALL be serialized so they cannot overlap-corrupt the restart

## ADDED Requirements

### Requirement: MCP mutations are serialized to prevent overlap corruption
The server SHALL serialize all runtime MCP mutations (add/remove/enable/disable) behind a single-flight mutex so that concurrent management-API calls cannot overlap their patch-write and reload/restart sequences. Each mutation SHALL complete (patch written + reload confirmed or restart finished) before the next begins. A debounced coalescing MAY merge rapid successive edits into one reload.

#### Scenario: concurrent add requests are serialized
- **WHEN** two management-API requests to add MCP servers arrive near-simultaneously
- **THEN** the server SHALL execute the first to completion before beginning the second
- **AND** neither the patch file nor the running dsh process SHALL be left in an overlap-corrupted state
