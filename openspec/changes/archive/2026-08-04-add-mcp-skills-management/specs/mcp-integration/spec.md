## MODIFIED Requirements

### Requirement: Server connects to MCP servers defined in mcp.json at startup
The server SHALL read `mcp.json` from the project root at startup and establish a connection to each configured MCP server, supporting both stdio servers (via `command`/`args`/`env`) and HTTP/SSE servers (via `url`/`headers`). The server SHALL also load MCP server configurations from the SQLite database (if present) and merge them with `mcp.json` entries, with database configs taking precedence for servers with the same name.

#### Scenario: stdio MCP server connects
- **WHEN** `mcp.json` declares a server with `command: "npx"` and `args: ["-y", "@modelcontextprotocol/server-memory"]`
- **THEN** the server SHALL spawn the process, connect via stdio transport, and complete the MCP handshake within the connection timeout

#### Scenario: HTTP/SSE MCP server connects
- **WHEN** `mcp.json` declares a server with `url` and `headers`
- **THEN** the server SHALL connect via HTTP transport and complete the MCP handshake within the connection timeout

#### Scenario: no mcp.json present
- **WHEN** the project root has no `mcp.json`
- **THEN** the server SHALL start normally with zero MCP servers from file and log that MCP is disabled

#### Scenario: database MCP servers are loaded
- **WHEN** the SQLite database contains MCP server configurations
- **THEN** the server SHALL load those configurations and connect to them alongside `mcp.json` entries
- **AND** database configurations SHALL override `mcp.json` entries with the same server name

### Requirement: MCP server tools are registered as agent-callable custom tools
The server SHALL discover each connected MCP server's tools via `listTools()` and register each as a pi `ToolDefinition` whose `execute()` proxies to the MCP server's `callTool()`, so the agent can invoke MCP tools identically to built-in tools. When MCP server configurations change at runtime (add/remove/enable/disable), the server SHALL update the tool registry accordingly without requiring a restart.

#### Scenario: MCP tool is callable by the agent
- **WHEN** a connected MCP server exposes a tool `search`
- **THEN** the agent session SHALL have a `search` tool available with the MCP tool's `inputSchema` as its parameter schema
- **AND** when the agent calls `search`, the call SHALL be forwarded to the MCP server and the result returned to the agent

#### Scenario: MCP tool parameter schema is preserved
- **WHEN** an MCP tool declares an `inputSchema` with required properties
- **THEN** the registered `ToolDefinition` SHALL carry that schema so the agent is informed of the expected parameters

#### Scenario: MCP server added at runtime
- **WHEN** a new MCP server is added via the management API
- **THEN** the server SHALL connect to it, discover its tools, and register them in the agent's tool registry
- **AND** the newly registered tools SHALL be immediately available to the agent

#### Scenario: MCP server removed at runtime
- **WHEN** an MCP server is removed via the management API
- **THEN** the server SHALL disconnect from it and unregister its tools from the agent's tool registry
- **AND** the removed tools SHALL no longer be available to the agent

#### Scenario: MCP server disabled at runtime
- **WHEN** an MCP server is disabled via the management API
- **THEN** the server SHALL disconnect from it and unregister its tools
- **AND** the server configuration SHALL be preserved so it can be re-enabled later

### Requirement: Failed MCP servers do not block agent startup
The server SHALL tolerate MCP servers that fail to connect, crash, or time out, without preventing the agent session from starting.

#### Scenario: MCP server fails to connect
- **WHEN** an MCP server's process cannot be started or its handshake times out
- **THEN** the server SHALL log a warning identifying the failed server, skip its tools, and proceed to start the agent session with the remaining MCP servers' tools

#### Scenario: MCP tool call errors are surfaced
- **WHEN** a connected MCP server returns an error for a `callTool` invocation or the connection drops mid-call
- **THEN** the tool execution SHALL return an error result to the agent rather than hanging, and the error SHALL propagate through the normal tool execution event stream
