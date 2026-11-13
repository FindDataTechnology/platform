## MODIFIED Requirements

### Requirement: Server connects to MCP servers defined in mcp.json at startup
The server SHALL read `mcp.json` from the project root at startup and pass the MCP server configurations (stdio `command`/`args`/`env` and HTTP/SSE `url`/`headers`) to the dsh runtime's `dsh-mcp-client` plugin via the dsh profile, rather than connecting via the host-side `mcp-bridge.js`. The server SHALL also load MCP server configurations from the SQLite database (if present) and merge them with `mcp.json` entries, with database configs taking precedence for servers with the same name, before passing the merged set to the profile.

#### Scenario: stdio MCP server connects
- **WHEN** `mcp.json` declares a server with `command: "npx"` and `args: ["-y", "@modelcontextprotocol/server-memory"]`
- **THEN** the dsh-mcp-client plugin SHALL spawn the process, connect via stdio transport, and complete the MCP handshake within the connection timeout

#### Scenario: HTTP/SSE MCP server connects
- **WHEN** `mcp.json` declares a server with `url` and `headers`
- **THEN** the dsh-mcp-client plugin SHALL connect via HTTP transport and complete the MCP handshake within the connection timeout

#### Scenario: no mcp.json present
- **WHEN** the project root has no `mcp.json`
- **THEN** the server SHALL start normally with zero MCP servers passed to the profile and log that MCP is disabled

#### Scenario: database MCP servers are loaded
- **WHEN** the SQLite database contains MCP server configurations
- **THEN** the server SHALL load those configurations and pass them to the dsh-mcp-client plugin alongside `mcp.json` entries
- **AND** database configurations SHALL override `mcp.json` entries with the same server name

### Requirement: MCP server tools are registered as agent-callable custom tools
The dsh `dsh-mcp-client` plugin SHALL discover each connected MCP server's tools via `listTools()` and register each with the name `mcp__<serverName>__<toolName>`, so the agent can invoke MCP tools identically to built-in tools. When MCP server configurations change at runtime (add/remove/enable/disable), the server SHALL update the dsh profile / runtime config accordingly without requiring a full restart, leveraging `dsh-mcp-client`'s hot-swap and reconnect behavior.

#### Scenario: MCP tool is callable by the agent
- **WHEN** a connected MCP server exposes a tool `search`
- **THEN** the agent SHALL have a `mcp__<server>__search` tool available with the MCP tool's `inputSchema` as its parameter schema
- **AND** when the agent calls it, the call SHALL be forwarded to the MCP server and the result returned to the agent

#### Scenario: MCP tool parameter schema is preserved
- **WHEN** an MCP tool declares an `inputSchema` with required properties
- **THEN** the registered dsh tool SHALL carry that schema so the agent is informed of the expected parameters

#### Scenario: MCP server added at runtime
- **WHEN** a new MCP server is added via the management API
- **THEN** the server SHALL pass the new config to the dsh-mcp-client plugin, which SHALL connect to it, discover its tools, and register them
- **AND** the newly registered tools SHALL be immediately available to the agent

#### Scenario: MCP server removed at runtime
- **WHEN** an MCP server is removed via the management API
- **THEN** the dsh-mcp-client plugin SHALL disconnect from it and unregister its tools
- **AND** the removed tools SHALL no longer be available to the agent

#### Scenario: MCP server disabled at runtime
- **WHEN** an MCP server is disabled via the management API
- **THEN** the dsh-mcp-client plugin SHALL disconnect from it and unregister its tools
- **AND** the server configuration SHALL be preserved so it can be re-enabled later

### Requirement: Failed MCP servers do not block agent startup
The dsh `dsh-mcp-client` plugin SHALL tolerate MCP servers that fail to connect, crash, or time out, without preventing the dsh runtime from starting. The host SHALL NOT abort startup on an MCP failure.

#### Scenario: MCP server fails to connect
- **WHEN** an MCP server's process cannot be started or its handshake times out
- **THEN** the dsh-mcp-client plugin SHALL log a warning identifying the failed server, skip its tools, and the runtime SHALL start with the remaining MCP servers' tools

#### Scenario: MCP tool call errors are surfaced
- **WHEN** a connected MCP server returns an error for a `callTool` invocation or the connection drops mid-call
- **THEN** the tool execution SHALL return an error result to the agent rather than hanging, and the error SHALL propagate through the normal translated tool-execution event stream
