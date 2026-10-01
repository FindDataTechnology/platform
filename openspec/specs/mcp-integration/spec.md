# mcp-integration Specification

## Purpose
TBD - created by archiving change add-mcp-skills-model-select. Update Purpose after archive.

## Requirements

### Requirement: Server connects to MCP servers defined in mcp.json at startup

The server SHALL read `mcp.json` from the project root at startup and pass the MCP server configurations (stdio `command`/`args`/`env` and HTTP/SSE `url`/`headers`) to the dsh runtime's `dsh-mcp-client` plugin via the dsh profile, rather than connecting via the host-side `mcp-bridge.js`. The server SHALL also load MCP server configurations from the SQLite database (if present) and merge them with `mcp.json` entries, with database configs taking precedence for servers with the same name, before passing the merged set to the profile. An authenticated user's personal MCP binding SHALL be an enabled/disabled overlay over this global merged set; it SHALL NOT change the source configurations or persist a per-user copy. Role gating composes with this overlay: an installed server whose record carries a non-empty `requiredGroups` SHALL be omitted from the effective profile unless the current user's groups intersect it, so a role revoked in the identity provider takes effect on the next profile application without uninstalling the server. Credential resolution composes with both: for registry-origin servers the `Authorization` header SHALL be resolved from the current user's stored registry credential at each profile application (see the `registry-credentials` capability), and a registry-origin server whose owner lacks a live credential SHALL be omitted from the effective profile with a warning instead of being passed with a placeholder header. When no authenticated identity exists (auth off), role gating SHALL NOT filter anything. Locked bundled servers without `requiredGroups` are unaffected.

#### Scenario: stdio MCP server connects
- **WHEN** `mcp.json` declares a server with `command: "npx"` and `args: ["-y", "@modelcontextprotocol/server-memory"]`
- **THEN** the dsh-mcp-client plugin SHALL spawn the process, connect via stdio transport, and complete the MCP handshake within the connection timeout

#### Scenario: HTTP/SSE MCP server connects
- **WHEN** `mcp.json` declares a server with `url` and `headers`
- **THEN** the dsh-mcp-client plugin SHALL connect via HTTP transport and complete the MCP handshake within the connection timeout

#### Scenario: registry-origin server receives injected credential
- **WHEN** the effective profile is generated for a user who installed a registry-origin server and holds a live registry credential
- **THEN** that server's connection configuration carries `Authorization: Bearer <stored credential>` resolved at profile-application time
- **AND** the stored installed record contains no embedded secret

#### Scenario: registry-origin server omitted without credential
- **WHEN** the effective profile is generated for a user whose registry credential is missing or stale
- **THEN** registry-origin servers are omitted from the effective profile and a warning is logged
- **AND** the installed records are unchanged, so the servers return once a credential is stored again

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

### Requirement: MCP server tools are registered as agent-callable custom tools

The dsh `dsh-mcp-client` plugin SHALL discover each connected MCP server's tools via `listTools()` and register each with the name `mcp__<serverName>__<toolName>`, so the agent can invoke MCP tools identically to built-in tools. When MCP server configurations change at runtime (add/remove/enable/disable), the server SHALL update the dsh profile / runtime config accordingly without requiring a full restart, leveraging `dsh-mcp-client`'s hot-swap and reconnect behavior. A personal MCP availability overlay SHALL change the effective tool set for the shared runtime when applied, without changing the global configuration record; a locked server SHALL remain enabled for every user.

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

#### Scenario: personal MCP availability hot-swaps tools
- **WHEN** an authenticated user's effective MCP profile changes while the runtime is idle
- **THEN** the runtime tool set is hot-swapped to match the effective profile
- **AND** the global MCP record is not modified

### Requirement: MCP mutations are serialized to prevent overlap corruption

The server SHALL serialize all runtime MCP mutations (add/remove/enable/disable and personal effective-profile applications) behind a single-flight mutex so that concurrent management-API calls cannot overlap their patch-write and reload/restart sequences. Each mutation SHALL complete (patch written + reload confirmed or restart finished) before the next begins. A debounced coalescing MAY merge rapid successive edits into one reload. Global configuration mutations and personal overlay applications SHALL use the same serialized path so one cannot overwrite the other's patch.

#### Scenario: concurrent add requests are serialized
- **WHEN** two management-API requests to add MCP servers arrive near-simultaneously
- **THEN** the server SHALL execute the first to completion before beginning the second
- **AND** neither the patch file nor the running dsh process SHALL be left in an overlap-corrupted state

#### Scenario: global and personal MCP changes do not overlap
- **WHEN** a global MCP mutation and a personal MCP overlay application arrive concurrently
- **THEN** one operation completes before the other begins
- **AND** the final runtime patch reflects the current global configuration plus the active personal overlay

### Requirement: Failed MCP servers do not block agent startup
The dsh `dsh-mcp-client` plugin SHALL tolerate MCP servers that fail to connect, crash, or time out, without preventing the dsh runtime from starting. The host SHALL NOT abort startup on an MCP failure.

#### Scenario: MCP server fails to connect
- **WHEN** an MCP server's process cannot be started or its handshake times out
- **THEN** the dsh-mcp-client plugin SHALL log a warning identifying the failed server, skip its tools, and the runtime SHALL start with the remaining MCP servers' tools

#### Scenario: MCP tool call errors are surfaced
- **WHEN** a connected MCP server returns an error for a `callTool` invocation or the connection drops mid-call
- **THEN** the tool execution SHALL return an error result to the agent rather than hanging, and the error SHALL propagate through the normal translated tool-execution event stream
