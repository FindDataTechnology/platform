## MODIFIED Requirements

### Requirement: Backend API for managing MCP servers at runtime

The server SHALL expose REST API endpoints to list, add, remove, enable, and disable MCP servers without requiring a server restart. Each listed server SHALL include its `origin` (`bundled` or `user`) and `locked` flag. Servers marked `locked` (packager-locked bundled entries) SHALL NOT be removable, disable-able, or config-editable via the API: such requests SHALL return 400 with an explanatory error. Authorization for these mutation endpoints SHALL be deployment-shaped: in a shared deployment (multiple identities against one runtime) mutations SHALL require the existing administrator group authorization — optional SSO identity alone SHALL NOT satisfy it; in a per-user hosted cell the single owning user SHALL be authorized to mutate MCP servers in their own cell without holding the administrator group, because their cell's configuration store is theirs alone. Mutations SHALL modify the cell's (or deployment's global) MCP configuration store, while personal availability toggles SHALL use the separate identity-scoped binding endpoints and SHALL NOT modify this store.

#### Scenario: list MCP servers via API
- **WHEN** client sends GET `/api/extensions/mcp`
- **THEN** the server SHALL return a list of all configured MCP servers with their name, config, status (connected/disconnected), enabled state, tool count, origin, and locked flag

#### Scenario: add MCP server via API
- **WHEN** an authorized requester (administrator in a shared deployment, or the cell owner in a per-user cell) sends POST `/api/extensions/mcp` with server config (name, command/args or url, headers, env)
- **THEN** the server SHALL persist the config (with `origin: "user"`), connect to the server, register its tools, and return success

#### Scenario: non-admin cannot mutate global MCP configuration
- **WHEN** authentication is enabled in a shared deployment (no cell owner) and a non-admin user sends a global MCP mutation
- **THEN** the server returns `403`
- **AND** the global configuration remains unchanged

#### Scenario: cell owner manages MCP in their own cell
- **WHEN** a hosted per-user cell is serving its owning user, who does not belong to the administrator group, and the owner sends POST/PATCH/DELETE `/api/extensions/mcp...`
- **THEN** the mutation SHALL be authorized and behave exactly as an administrator's mutation in a shared deployment

#### Scenario: remove MCP server via API
- **WHEN** an authorized requester sends DELETE `/api/extensions/mcp/:name`
- **THEN** the server SHALL disconnect from the server, unregister its tools, remove the config, and return success
- **WHEN** the named server is locked
- **THEN** the server SHALL return 400 and leave the entry untouched

#### Scenario: enable/disable MCP server via API
- **WHEN** an authorized requester sends PATCH `/api/extensions/mcp/:name` with `{ "enabled": false }`
- **THEN** the server SHALL disconnect from the server, unregister its tools, mark it disabled, and return success
- **WHEN** an authorized requester sends PATCH `/api/extensions/mcp/:name` with `{ "enabled": true }`
- **THEN** the server SHALL connect to the server, register its tools, mark it enabled, and return success
- **WHEN** the named server is locked
- **THEN** enable/disable and config-update requests SHALL return 400 and leave the entry untouched

### Requirement: Extension records carry origin, lock, and permission metadata
The extensions store SHALL persist for every MCP server and skill record: `origin` (`bundled` | `user`, defaulting to `user` for existing and newly added records), `locked` (default false), `permissions` (nullable JSON holding `allow`/`deny` tool globs), and `requiredGroups` (nullable JSON array of group names, stamped from the market entry's groups at gated-install time; null for ungated installs and all pre-existing rows). Existing rows SHALL migrate to these defaults losslessly. Permission enforcement is a separate capability; this requirement covers storage and API exposure only.

#### Scenario: existing records migrate to user origin
- **WHEN** the server starts against a DB created before origin/locked/permissions/requiredGroups existed
- **THEN** every existing record reports `origin: "user"`, `locked: false`, null permissions, and null requiredGroups
- **AND** all prior behaviors (list/add/remove/enable/disable) work unchanged

#### Scenario: bundled records expose their metadata
- **WHEN** a bundled MCP server with `locked: true` and permissions is seeded
- **THEN** GET `/api/extensions/mcp` includes its origin, locked flag, and permissions payload

#### Scenario: gated install exposes requiredGroups
- **WHEN** an MCP record was installed from a market entry carrying groups `["mcp-jira-users"]`
- **THEN** GET `/api/extensions/mcp` includes `requiredGroups: ["mcp-jira-users"]` for that record
