# extension-runtime-management Specification

## Purpose
Runtime management of the agent's extensions — MCP servers and skills — without a server restart: REST endpoints to list, add, remove, enable and disable each kind; records carrying `origin` (bundled / user), `locked`, `permissions` and `requiredGroups` metadata, with packager-locked bundled entries immutable through the API; hot-reload of MCP connections and skill registrations on every mutation; persistence across restarts; and a separate email-keyed personal MCP availability overlay applied through the shared effective-profile path.

## Requirements

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

### Requirement: Backend API for managing skills at runtime

The server SHALL expose REST API endpoints to list, add, remove, enable, and disable skills without requiring a server restart. Each listed skill SHALL include its `origin` and `locked` flag. Locked bundled skills SHALL NOT be removable, disable-able, or editable via the API: such requests SHALL return 400. A skill record MAY additionally carry an auxiliary file set (a mapping of relative paths to text contents) and external-origin provenance metadata; a record without them behaves as a single-file skill exactly as before, and every existing record (pre-migration rows) SHALL remain in that single-file shape with unchanged behavior. The list endpoint SHALL expose each skill's auxiliary file inventory (paths only) and its external provenance when present, so clients can distinguish multi-file and externally-installed skills from locally authored ones. The add endpoint SHALL accept, alongside the single-document shape, a package upload parsed under the platform's package contract — path safety, text-only admission, per-file and aggregate bounds, script inventory — rejecting a violating package with a named cause and creating nothing; the update endpoint SHALL replace a skill's auxiliary file set and stored frontmatter wholesale when they are present in the request, leaving them untouched when they are absent.

The list endpoint SHALL accept the shared locale resolution (explicit `locale` parameter > `Accept-Language` first tag > zh) and project supply annotations per request locale: registry-sourced skills via `metadata.annotations`, file skills via the repo annotation source's `skills` key. An unannotated skill's entry SHALL remain byte-identical to the pre-change payload, and annotation projection MUST NOT perform any source writes.

#### Scenario: list skills via API

- **WHEN** client sends GET `/api/extensions/skills`
- **THEN** the server SHALL return a list of all skills with their name, description, source (built-in/custom/bundled), enabled state, origin, and locked flag
- **AND** a multi-file skill's entry SHALL additionally expose its auxiliary file paths and external provenance

#### Scenario: add custom skill via API

- **WHEN** client sends POST `/api/extensions/skills` with skill definition (name, description, body)
- **THEN** the server SHALL persist the skill (with `origin: "user"`), register it with the agent, and return success

#### Scenario: add custom skill from a package via API

- **WHEN** client sends POST `/api/extensions/skills` with an uploaded package (zip)
- **THEN** the server SHALL parse it under the package contract, persist the skill with its body, auxiliary file set, and captured frontmatter (with the platform's name and description), materialize the directory tree, and return the inventory

#### Scenario: package violating the contract is refused whole

- **WHEN** the uploaded package contains a path with `..` segments or exceeds an aggregate bound
- **THEN** the server SHALL return a 4xx naming the violating file or bound, and no skill row or materialized file is created

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

#### Scenario: legacy single-file records are unchanged

- **WHEN** the server starts against a database created before auxiliary files existed
- **THEN** every existing skill lists with no auxiliary files and no external provenance, and all prior behaviors (list/add/remove/enable/disable) work unchanged

#### Scenario: annotated skill lists localized under its locale

- **WHEN** client sends GET `/api/extensions/skills?locale=zh` for a skill carrying a zh annotation
- **THEN** the entry carries the projected annotation (localized name and summary) alongside the unchanged slug and description
- **AND** the same request without the annotation present returns the entry exactly as before this change

#### Scenario: unannotated skill is byte-identical across locales

- **WHEN** client requests the list with `locale=zh` and `locale=en` for a skill with no annotation
- **THEN** both responses render the raw upstream text, identical to each other and to the pre-change payload

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

### Requirement: Hot-reload MCP connections on config change

The server SHALL support connecting to new MCP servers and disconnecting from existing ones at runtime, updating the agent's available tools without restarting. Global add/remove/enable/disable mutations SHALL update the global configuration and trigger the normal hot-reload path. A personal MCP availability binding SHALL update only the effective runtime overlay when applied; it SHALL use the same serialized hot-reload path but SHALL NOT alter the global configuration or its enabled flag.

#### Scenario: new MCP server connected at runtime
- **WHEN** an MCP server is added via API
- **THEN** the server SHALL establish a connection, discover its tools, register them as `ToolDefinition`s, and update the agent's tool allowlist
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

#### Scenario: MCP server disconnected at runtime
- **WHEN** an MCP server is removed or disabled via API
- **THEN** the server SHALL close the connection, unregister its tools from the agent's tool allowlist
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

#### Scenario: personal MCP availability reloads without global mutation
- **WHEN** an authenticated user's effective MCP overlay changes while the runtime is idle
- **THEN** the runtime hot-reloads the effective tool set
- **AND** `GET /api/extensions/mcp` still reports the unchanged global enabled state

### Requirement: Hot-reload skill registrations on config change
The server SHALL support registering and unregistering skills at runtime, updating the agent's available skills without restarting.

#### Scenario: new skill registered at runtime
- **WHEN** a skill is added or enabled via API
- **THEN** the server SHALL load the skill into the agent's skill registry
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

#### Scenario: skill unregistered at runtime
- **WHEN** a skill is removed or disabled via API
- **THEN** the server SHALL remove the skill from the agent's skill registry
- **AND** broadcast an `extensions_changed` WebSocket event to all clients

### Requirement: MCP and skill configs persist across restarts
The server SHALL persist MCP server configurations and custom skill definitions so they survive server restarts.

#### Scenario: MCP server config persistss
- **WHEN** an MCP server is added via API and the server restarts
- **THEN** the server SHALL reconnect to that MCP server on startup

#### Scenario: custom skill persists
- **WHEN** a custom skill is added via API and the server restarts
- **THEN** the server SHALL reload that skill on startup

### Requirement: Personal MCP availability is a separate management operation

The server SHALL expose an authenticated personal MCP availability endpoint that accepts an existing global MCP name and a boolean enabled value. The endpoint SHALL persist an email-keyed overlay, reject unknown names and attempts to disable locked servers, and apply the resulting effective profile through the shared runtime coordinator. The endpoint SHALL never expose or persist MCP URLs, headers, credentials, permissions, or complete configurations.

#### Scenario: personal toggle is authorized
- **WHEN** an authenticated user toggles an existing non-locked MCP server
- **THEN** the personal overlay is saved
- **AND** the global MCP record is unchanged

#### Scenario: personal toggle is rejected for a locked server
- **WHEN** an authenticated user attempts to disable a locked MCP server
- **THEN** the server returns an error
- **AND** the server remains enabled in the effective profile

### Requirement: 市场来源的凭据不落明文

系统 SHALL 把「来自市场」视为一个渠道事实，其对所有市场来源一视同仁（登记源
`registry` 与 `facet-catalog` 同权，判定口径与 pack 安装路径一致）。对市场来源的
MCP 安装，系统 MUST 只记录凭据引用（`credentialRef`），MUST NOT 把访问令牌写进
扩展记录的配置。

所需凭据未连接时，系统 MUST 拒绝安装并给出结构化的「需要连接」原因与连接入口，
MUST NOT 落一个带占位符或空凭据的条目。

#### Scenario: 市场来源装出的是引用而非令牌
- **WHEN** 用户安装一条市场来源（`registry` 或 `facet-catalog`）的 MCP 条目
- **THEN** 落库的记录带凭据引用，其配置中不含 `Authorization` 令牌

#### Scenario: 两个市场来源判定一致
- **WHEN** 同一服务分别经 `registry` 来源与 `facet-catalog` 来源被安装
- **THEN** 两条安装路径产生同样形状的记录（都带凭据引用），不存在一条存引用、另一条存令牌

#### Scenario: 缺凭据拒绝安装
- **WHEN** 用户安装市场来源条目但尚未连接该条目所需的凭据
- **THEN** 安装被拒绝，返回结构化的「需要连接」原因与连接入口，且不写入任何条目

#### Scenario: 非市场来源保持原样
- **WHEN** 安装的是运维在配置文件中声明的本地/手写条目
- **THEN** 该条目按其声明原样生效，本要求不改变其行为

### Requirement: 读取面不返回明文凭据

扩展读取面 SHALL 对配置中的凭据字段做掩码，MUST NOT 原样返回令牌。响应 SHOULD
标明该条目是「引用式」还是「内联式」凭据，使界面能引导用户改走连接入口。

#### Scenario: 列表响应里看不到令牌
- **WHEN** 客户端读取 MCP 扩展列表
- **THEN** 任何条目的配置中都不出现完整令牌，令牌位置为掩码

#### Scenario: 同一行的每一份副本都不得带出令牌
- **WHEN** 客户端读取 MCP 扩展列表，且存储层为同一行保留了多种表示
  （如解析后的配置对象与其原始序列化列）
- **THEN** 响应中任何一处表示都不得含完整令牌；不构成对外契约的原始副本
  不返回，而不是仅仅掩码

#### Scenario: 条目区分凭据形态
- **WHEN** 客户端读取一条 MCP 扩展
- **THEN** 响应标明其凭据是引用式还是内联式，供界面决定是否提示用户改造
