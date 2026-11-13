## MODIFIED Requirements

### Requirement: Server registers the OpenConnector MCP endpoint with the agent when enabled

When the module is enabled, the server SHALL build an HTTP MCP server config pointing at `<base>/mcp` (with the runtime token as a Bearer header) and pass it to the dsh runtime's `dsh-mcp-client` plugin configuration (via the profile) so the runtime's tools (`list_apps`, `search_actions`, `get_action_guide`, `execute_action`) are registered as agent-callable tools by dsh, rather than by server-side JavaScript bridge code. The OpenConnector tool names SHALL use the `mcp__open-connector__` prefix via dsh's naming convention. A failure to connect the OpenConnector MCP server SHALL NOT prevent the dsh runtime / agent session from starting.

#### Scenario: OpenConnector tools are available to the agent

- **WHEN** the module is enabled and the runtime's `/mcp` endpoint is reachable
- **THEN** the dsh runtime SHALL have the four OpenConnector MCP tools available (named with the `mcp__open-connector__` prefix)
- **AND** the server SHALL log how many OpenConnector tools were registered
