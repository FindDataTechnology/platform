## ADDED Requirements

### Requirement: Server connects to MCP servers defined in mcp.json at startup
The server SHALL read `mcp.json` from the project root at startup and establish a connection to each configured MCP server, supporting both stdio servers (via `command`/`args`/`env`) and HTTP/SSE servers (via `url`/`headers`).

#### Scenario: stdio MCP server connects
- **WHEN** `mcp.json` declares a server with `command: "npx"` and `args: ["-y", "@modelcontextprotocol/server-memory"]`
- **THEN** the server SHALL spawn the process, connect via stdio transport, and complete the MCP handshake within the connection timeout

#### Scenario: HTTP/SSE MCP server connects
- **WHEN** `mcp.json` declares a server with `url` and `headers`
- **THEN** the server SHALL connect via HTTP transport and complete the MCP handshake within the connection timeout

#### Scenario: no mcp.json present
- **WHEN** the project root has no `mcp.json`
- **THEN** the server SHALL start normally with zero MCP servers and log that MCP is disabled

### Requirement: MCP server tools are registered as agent-callable custom tools
The server SHALL discover each connected MCP server's tools via `listTools()` and register each as a pi `ToolDefinition` whose `execute()` proxies to the MCP server's `callTool()`, so the agent can invoke MCP tools identically to built-in tools.

#### Scenario: MCP tool is callable by the agent
- **WHEN** a connected MCP server exposes a tool `search`
- **THEN** the agent session SHALL have a `search` tool available with the MCP tool's `inputSchema` as its parameter schema
- **AND** when the agent calls `search`, the call SHALL be forwarded to the MCP server and the result returned to the agent

#### Scenario: MCP tool parameter schema is preserved
- **WHEN** an MCP tool declares an `inputSchema` with required properties
- **THEN** the registered `ToolDefinition` SHALL carry that schema so the agent is informed of the expected parameters

### Requirement: Failed MCP servers do not block agent startup
The server SHALL tolerate MCP servers that fail to connect, crash, or time out, without preventing the agent session from starting.

#### Scenario: MCP server fails to connect
- **WHEN** an MCP server's process cannot be started or its handshake times out
- **THEN** the server SHALL log a warning identifying the failed server, skip its tools, and proceed to start the agent session with the remaining MCP servers' tools

#### Scenario: MCP tool call errors are surfaced
- **WHEN** a connected MCP server returns an error for a `callTool` invocation or the connection drops mid-call
- **THEN** the tool execution SHALL return an error result to the agent rather than hanging, and the error SHALL propagate through the normal tool execution event stream
