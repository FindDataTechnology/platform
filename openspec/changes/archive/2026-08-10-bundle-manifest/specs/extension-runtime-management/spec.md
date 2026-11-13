## MODIFIED Requirements

### Requirement: Backend API for managing MCP servers at runtime
The server SHALL expose REST API endpoints to list, add, remove, enable, and disable MCP servers without requiring a server restart. Each listed server SHALL include its `origin` (`bundled` or `user`) and `locked` flag. Servers marked `locked` (packager-locked bundled entries) SHALL NOT be removable, disable-able, or config-editable via the API: such requests SHALL return 400 with an explanatory error.

#### Scenario: list MCP servers via API
- **WHEN** client sends GET `/api/extensions/mcp`
- **THEN** the server SHALL return a list of all configured MCP servers with their name, config, status (connected/disconnected), enabled state, tool count, origin, and locked flag

#### Scenario: add MCP server via API
- **WHEN** client sends POST `/api/extensions/mcp` with server config (name, command/args or url, headers, env)
- **THEN** the server SHALL persist the config (with `origin: "user"`), connect to the server, register its tools, and return success

#### Scenario: remove MCP server via API
- **WHEN** client sends DELETE `/api/extensions/mcp/:name`
- **THEN** the server SHALL disconnect from the server, unregister its tools, remove the config, and return success
- **WHEN** the named server is locked
- **THEN** the server SHALL return 400 and leave the entry untouched

#### Scenario: enable/disable MCP server via API
- **WHEN** client sends PATCH `/api/extensions/mcp/:name` with `{ "enabled": false }`
- **THEN** the server SHALL disconnect from the server, unregister its tools, mark it disabled, and return success
- **WHEN** client sends PATCH `/api/extensions/mcp/:name` with `{ "enabled": true }`
- **THEN** the server SHALL connect to the server, register its tools, mark it enabled, and return success
- **WHEN** the named server is locked
- **THEN** enable/disable and config-update requests SHALL return 400 and leave the entry untouched

### Requirement: Backend API for managing skills at runtime
The server SHALL expose REST API endpoints to list, add, remove, enable, and disable skills without requiring a server restart. Each listed skill SHALL include its `origin` and `locked` flag. Locked bundled skills SHALL NOT be removable, disable-able, or editable via the API: such requests SHALL return 400.

#### Scenario: list skills via API
- **WHEN** client sends GET `/api/extensions/skills`
- **THEN** the server SHALL return a list of all skills with their name, description, source (built-in/custom/bundled), enabled state, origin, and locked flag

#### Scenario: add custom skill via API
- **WHEN** client sends POST `/api/extensions/skills` with skill definition (name, description, body)
- **THEN** the server SHALL persist the skill (with `origin: "user"`), register it with the agent, and return success

#### Scenario: remove custom skill via API
- **WHEN** client sends DELETE `/api/extensions/skills/:name`
- **THEN** the server SHALL unregister the skill, remove its definition, and return success
- **AND** built-in skills SHALL NOT be removable (return 400)
- **AND** locked bundled skills SHALL NOT be removable (return 400)

#### Scenario: enable/disable skill via API
- **WHEN** client sends PATCH `/api/extensions/skills/:name` with `{ "enabled": false }`
- **THEN** the server SHALL unregister the skill from the agent, mark it disabled, and return success
- **WHEN** client sends PATCH `/api/extensions/skills/:name` with `{ "enabled": true }`
- **THEN** the server SHALL register the skill with the agent, mark it enabled, and return success
- **WHEN** the named skill is locked
- **THEN** enable/disable requests SHALL return 400 and leave the entry untouched

## ADDED Requirements

### Requirement: Extension records carry origin, lock, and permission metadata
The extensions store SHALL persist for every MCP server and skill record: `origin` (`bundled` | `user`, defaulting to `user` for existing and newly added records), `locked` (default false), and `permissions` (nullable JSON holding `allow`/`deny` tool globs). Existing rows SHALL migrate to these defaults losslessly. Permission enforcement is a separate capability; this requirement covers storage and API exposure only.

#### Scenario: existing records migrate to user origin
- **WHEN** the server starts against a DB created before origin/locked/permissions existed
- **THEN** every existing record reports `origin: "user"`, `locked: false`, and null permissions
- **AND** all prior behaviors (list/add/remove/enable/disable) work unchanged

#### Scenario: bundled records expose their metadata
- **WHEN** a bundled MCP server with `locked: true` and permissions is seeded
- **THEN** GET `/api/extensions/mcp` includes its origin, locked flag, and permissions payload
