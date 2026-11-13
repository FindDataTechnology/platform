## MODIFIED Requirements

### Requirement: Backend API for managing MCP servers at runtime

The server SHALL expose REST API endpoints to list, add, remove, enable, and disable MCP servers without requiring a server restart. Each listed server SHALL include its `origin` (`bundled` or `user`) and `locked` flag. Servers marked `locked` (packager-locked bundled entries) SHALL NOT be removable, disable-able, or config-editable via the API: such requests SHALL return 400 with an explanatory error. Authorization for these mutation endpoints SHALL be deployment-shaped: in a shared deployment (multiple identities against one runtime) mutations SHALL require the existing administrator group authorization — optional SSO identity alone SHALL NOT satisfy it; in a per-user hosted cell the single owning user SHALL be authorized to mutate MCP servers in their own cell without holding the administrator group, because their cell's configuration store is theirs alone. Mutations SHALL modify the cell's (or deployment's global) MCP configuration store, while personal availability toggles SHALL use the separate identity-scoped binding endpoints and SHALL NOT modify this store. `credentialRef` is a system-managed marker: a client-submitted server config (add or update) that carries a `credentialRef` field SHALL be rejected with 400 and an explanatory error, and SHALL NOT be persisted; the marker may only be stamped by the platform (market-catalog installs of credential-origin servers) or declared in the operator-level `mcp.json`.

#### Scenario: list MCP servers via API

- **WHEN** client sends GET `/api/extensions/mcp`
- **THEN** the server SHALL return a list of all configured MCP servers with their name, config, status (connected/disconnected), enabled state, tool count, origin, and locked flag

#### Scenario: add MCP server via API

- **WHEN** an authorized requester (administrator in a shared deployment, or the cell owner in a per-user cell) sends POST `/api/extensions/mcp` with server config (name, command/args or url, headers, env)
- **THEN** the server SHALL persist the config (with `origin: "user"`), connect to the server, register its tools, and return success

#### Scenario: client-submitted credentialRef is rejected

- **WHEN** an authorized requester submits a server config (add or update) whose body carries a `credentialRef` field
- **THEN** the server SHALL return 400 explaining that `credentialRef` is system-managed
- **AND** no configuration row SHALL be created or modified

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
