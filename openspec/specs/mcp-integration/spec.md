# mcp-integration Specification

## Purpose
MCP servers declared in mcp.json, the DB, and market installs are composed into the dsh runtime: connected over stdio/HTTP, credential-resolved per user, role-filtered, and observable — with the host patch file as the single write point.

## Requirements

### Requirement: Server connects to MCP servers defined in mcp.json at startup

The server SHALL read `mcp.json` from the project root at startup and pass the MCP server configurations (stdio `command`/`args`/`env` and HTTP/SSE `url`/`headers`) to the dsh runtime's `dsh-mcp-client` plugin via the dsh profile, rather than connecting via the host-side `mcp-bridge.js`. The server SHALL also load MCP server configurations from the SQLite database (if present) and merge them with `mcp.json` entries, with database configs taking precedence for servers with the same name, before passing the merged set to the profile. An authenticated user's personal MCP binding SHALL be an enabled/disabled overlay over this global merged set; it SHALL NOT change the source configurations or persist a per-user copy. Role gating composes with this overlay: an installed server whose record carries a non-empty `requiredGroups` SHALL be omitted from the effective profile unless the current user's groups intersect it, so a role revoked in the identity provider takes effect on the next profile application without uninstalling the server. Credential resolution composes with both: a server whose configuration carries a `credentialRef` SHALL have its `Authorization` header resolved from the current user's stored credential for that ref at each profile application (the `registry` ref resolves through the `registry-credentials` capability, the `connector` ref through the `connector-credentials` capability), and such a server whose owner lacks a live credential for its ref SHALL be omitted from the effective profile with a warning instead of being passed with a placeholder header. A `credentialRef` that cannot be resolved for any reason SHALL cause the carrying server to be omitted rather than passed unauthenticated. When no authenticated identity exists (auth off), role gating SHALL NOT filter anything. Locked bundled servers without `requiredGroups` are unaffected.

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

#### Scenario: connector server receives injected credential
- **WHEN** the effective profile is generated for a user who holds a live connector credential and whose profile includes a server carrying `credentialRef: "connector"`
- **THEN** that server's connection configuration carries `Authorization: Bearer <the user's connector PAT>` resolved at profile-application time
- **AND** the stored configuration contains no embedded token

#### Scenario: connector server omitted without credential
- **WHEN** the effective profile is generated for a user with no live connector credential
- **THEN** the `credentialRef: "connector"` server is omitted from the effective profile and a warning is logged
- **AND** the configuration row is unchanged, so the server returns once a PAT is stored

#### Scenario: unresolvable ref never passes unauthenticated
- **WHEN** credential resolution for a server's `credentialRef` fails — an unknown ref name, a store error, or an unavailable module
- **THEN** every server carrying a `credentialRef` is omitted from the effective profile and a warning is logged
- **AND** no server is passed downstream with a placeholder or empty Authorization header

#### Scenario: refreshed connector PAT flows without reinstall
- **WHEN** a user replaces their stored connector PAT
- **THEN** the next effective-profile write injects the new value into the connector server's header
- **AND** no reinstall or configuration edit is required

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

### Requirement: MCP patch file is written with owner-only permissions

MCP patch 文件（以及后续任何经同一原子写路径落盘、承载凭据值的文件）以 0600 权限写入：仅属主可读写，group/other 无任何位。

#### Scenario: patch written with 0600

- **WHEN** writeMcpPatch 写出含 Authorization 头或凭据型 env 值的 patch 文件
- **THEN** 该文件 mode 为 0600（umask 不影响结果）

#### Scenario: pre-existing 0644 patch is tightened on next write

- **WHEN** 一个旧版本写出的 0644 patch 被同路径重写
- **THEN** 重写后的文件 mode 为 0600（原子替换天然携带新 mode）

### Requirement: Platform-wide shared secrets are not injected into cell patches

凡 host 已知作用域化机制的平台级共享秘密（首例：search relay 凭据），不得以全平台单一值进入任何 cell 的 MCP patch；注入值必须是该 cell 专属、可单独吊销的派生值。用户自有凭据（其本人的 registry/connector key）不在此约束内——cell 内可见用户自己的钥匙是既有威胁模型接受的暴露面。

#### Scenario: websearch env in a cell patch is cell-scoped

- **WHEN** 任一 cell 的 MCP patch 因 websearch 基线 server 写入 `SEARCH_RELAY_TOKEN` 值
- **THEN** 该值仅对该 cell 有效；用另一 cell 的同名值请求 relay 被拒

#### Scenario: fallback to shared token remains possible while scoped derivation is unset

- **WHEN** 部署未配置派生 master secret（静态令牌模式）
- **THEN** 写 patch 行为与现状一致（共享值注入），并在日志输出一次性降级提示——迁移期不制造硬故障

### Requirement: HTTP MCP servers get a preflight health signal surfaced by the platform

host 在 MCP patch 的组合时刻（装包、server 增删启停、profile 应用）对每个 http 型 server 用与 dsh 运行时相同的 URL 与解析后凭据做一次轻量探活，结果（ok / unreachable / auth-rejected / server-error）落 store，并经只读诊断端点暴露；探活失败不得阻断 patch 写出或装包流程（观测不引入新的失败面）。

#### Scenario: auth failure is visible

- **WHEN** 某 registry-origin server 的凭据被上游 401 拒绝
- **THEN** 诊断端点对该 server 报 `auth-rejected`（含时间戳），patch 仍正常写出——但"已装/已启用/无工具"的三无声状态不再存在

#### Scenario: server outage is visible

- **WHEN** 某 http server 返回 5xx 或连接超时
- **THEN** 诊断端点对该 server 报对应失败态，与 401 态区分展示

#### Scenario: preflight itself degraded

- **WHEN** 探活机制自身不可用（如网络策略限制 egress）
- **THEN** 诊断端点报 `unknown` 态，不误报 ok/failed；patch 写出不受影响
