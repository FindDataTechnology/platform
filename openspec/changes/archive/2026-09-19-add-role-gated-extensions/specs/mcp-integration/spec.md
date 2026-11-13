## MODIFIED Requirements

### Requirement: Server connects to MCP servers defined in mcp.json at startup

The server SHALL read `mcp.json` from the project root at startup and pass the MCP server configurations (stdio `command`/`args`/`env` and HTTP/SSE `url`/`headers`) to the dsh runtime's `dsh-mcp-client` plugin via the dsh profile, rather than connecting via the host-side `mcp-bridge.js`. The server SHALL also load MCP server configurations from the SQLite database (if present) and merge them with `mcp.json` entries, with database configs taking precedence for servers with the same name, before passing the merged set to the profile. An authenticated user's personal MCP binding SHALL be an enabled/disabled overlay over this global merged set; it SHALL NOT change the source configurations or persist a per-user copy. Role gating composes with this overlay: an installed server whose record carries a non-empty `requiredGroups` SHALL be omitted from the effective profile unless the current user's groups intersect it, so a role revoked in the identity provider takes effect on the next profile application without uninstalling the server. When no authenticated identity exists (auth off), role gating SHALL NOT filter anything. Locked bundled servers without `requiredGroups` are unaffected.

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

#### Scenario: personal MCP overlay is applied
- **WHEN** an authenticated user's personal binding disables a globally configured non-locked MCP server
- **THEN** that server is omitted from the user's effective runtime profile
- **AND** its global configuration remains stored and available to other users

#### Scenario: role-restricted server is omitted for non-members
- **WHEN** an installed MCP server carries `requiredGroups: ["mcp-jira-users"]` and the current user's groups do not include it
- **THEN** that server is omitted from the user's effective runtime profile and its tools are unavailable to the agent
- **AND** the stored configuration is unchanged, so the server returns when the role is granted again

#### Scenario: role revocation takes effect on next profile application
- **WHEN** a user's role is revoked in the identity provider while their cell or session holds an installed server gated on that role
- **THEN** the next effective-profile generation SHALL omit that server
- **AND** no uninstall or record mutation SHALL be required

#### Scenario: no identity means no role filtering
- **WHEN** authentication is off and an installed server carries `requiredGroups`
- **THEN** the server SHALL be included in the effective profile, because the requester is the machine owner
