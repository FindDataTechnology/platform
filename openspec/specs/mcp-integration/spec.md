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

The dsh `dsh-mcp-client` plugin SHALL discover each connected MCP server's tools via `listTools()` and register each with the name `mcp__<serverName>__<toolName>`, so the agent can invoke MCP tools identically to built-in tools. When MCP server configurations change at runtime (add/remove/enable/disable), the server SHALL update the dsh profile / runtime config accordingly without requiring a full restart, leveraging `dsh-mcp-client`'s hot-swap and reconnect behavior. **凭据值变化除外**：当一次 profile/patch 写入只改变既有 server 行的凭据值（Authorization 头变化，无 server 增删）时，平台 SHALL 以 runtime child restart 交付——空闲（无在跑回合）立即执行，忙则推迟到最近的回合边界；平台 SHALL NOT 信任 hot-swap 交付头值变化（无确认信号，生产已实证不生效）。A personal MCP availability overlay SHALL change the effective tool set for the shared runtime when applied, without changing the global configuration record; a locked server SHALL remain enabled for every user.

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

#### Scenario: 凭据变化以 restart 交付（空闲）

- **WHEN** 一次 patch 写入仅改变既有 server 的 Authorization 头值（续期/重铸落库后的重应用）且 runtime 空闲
- **THEN** 平台重启 runtime child（新子进程从磁盘重读 patch），重启完成后起的回合使用新 token
- **AND** 该交付不依赖 hot-swap 信号，重启完成即可证明

#### Scenario: 凭据变化忙时推迟到回合边界

- **WHEN** 凭据变化发生时有回合在跑
- **THEN** 平台不中断在跑回合，推迟 restart 到回合边界（idle 回调或下一回合开始前）执行
- **AND** 推迟后的下一个回合使用新 token（续期/重铸后 ≤5 分钟内起的回合为准）

#### Scenario: 非凭据变化维持 hot-swap

- **WHEN** patch 写入只是 server 增删/启停（Authorization 头值不变）
- **THEN** 沿用 hot-swap 交付，行为与本 change 之前完全一致

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

### Requirement: 声明所需 env 的 stdio 服务器在 env 缺失时整体省略

MCP 配置中的 stdio 服务器条目 SHALL 可声明「所需环境变量名单」（env 上界声明）。当该名单中的环境变量在部署环境全部缺失时，组合 MCP patch SHALL 整体省略该服务器条目——不写 patch、不拉起子进程、不进入任何用户的工具面；该省略 MUST 是静默的正常态（非警告级降级，与 envRefs 缺名时的「警告 + 降级运行」语义并存且互不干扰）。名单部分缺失时按既有 envRefs 语义处理（转发已设值、警告缺失项）。省略与恢复 SHALL 仅随部署 env 配置变化生效（重组时重新判定），MUST NOT 需要改库或重装。

#### Scenario: 未配 env 的部署零污染

- **WHEN** 某部署未配置 `CHATWOOT_BASE_URL` / `CHATWOOT_API_TOKEN` 而配置仓中的 chatwoot 条目声明了所需 env 名单
- **THEN** 该部署任一用户的 MCP patch 与工具面均不含 chatwoot 服务器，无子进程拉起，日志无警告刷屏

#### Scenario: 配齐 env 后服务器出现

- **WHEN** 同一部署随后配齐所需 env 并重组（重启或 HMR）
- **THEN** chatwoot 服务器条目出现在 patch 中，子进程带 env 拉起，agent 工具面含其标准子集

#### Scenario: 部分缺失走既有降级语义

- **WHEN** 所需 env 名单只配了一部分（如只有 BASE_URL 没有 TOKEN）
- **THEN** 已设值照常转发，缺失项按 envRefs 既有语义警告，服务器条目不省略（由 server 自身以缺 env 明确报错）

### Requirement: stdio env 值解析自逐用户凭据

本地 stdio 服务器行 SHALL 可声明「env 名 → credentialRef」映射；MCP patch 组合时该 env 值 SHALL 从声明 ref 的**该用户**凭据解析（与 HTTP 条目 Authorization 头同一解析口径），MUST NOT 使用部署 env 或他人凭据。该用户无此 ref 的活凭据时，该条目对该用户 SHALL 整体省略（不写 patch、不拉子进程），省略为静默正常态；机器 owner（无认证身份）SHALL 维持既有部署 env 语义（组合结果与该能力引入前逐字节一致），MUST NOT 因引入本机制而改变。上游 401 SHALL 使该用户此凭据失效（与既有 ref 失效语义一致）。

#### Scenario: 凭据按用户隔离解析

- **WHEN** 两个用户各自连接了不同的 Chatwoot token 并各自组合运行时
- **THEN** 各自 cell patch 的 chatwoot env 只携带自己的 token，互不可见

#### Scenario: 无凭据的用户零污染

- **WHEN** 未连接 chatwoot 的用户组合运行时
- **THEN** patch 无 chatwoot 条目、无子进程拉起、无警告刷屏

#### Scenario: 失效凭据置 stale

- **WHEN** 某用户的 token 被 Chatwoot 吊销后其 cell 调用 chatwoot 工具收到 401
- **THEN** 该用户此凭据置 stale，浏览器下次访问收到重连接指引

### Requirement: 凭据形 patch 变化的一切交付路径同受交付控制器管辖

当一次 patch 写入因快照不可比（首装、ref 携带服务从无到有、patch 从无到有）而落入
非热交换的兜底 restart 路径时，平台 SHALL 以凭据交付控制器执行该 restart——碰撞
（restart already in progress）SHALL 重试而非向上抛出后吞掉；有回合在跑 SHALL 推迟到
回合边界并受硬顶约束。**「有回合在跑」的判定 SHALL 覆盖共享运行时子进程上的一切在途回合**：
web 活回合与经收集器注册的非 web 回合（定时任务、委托、bot 中继）同权——判定 MUST NOT
只看 web 活回合（生产 2026-10-24 深夜：舰队巡逻回合流式中凭据变更被误判空闲、子进程立即
重启致回合中断，9 连败中至少 3 次死于此）。**硬顶 SHALL 不小于共享子进程上最长的单回合
预算**（默认回合超时 10 分钟）：一次合法在途回合（未逾自身回合预算）SHALL NOT 被硬顶强推
打断；等待超过硬顶且此刻无在途回合时照常交付；在途回合期唯一的强推是楔死释放——
回合已逾其自身预算仍未终止时，凭据不得被无限期扣押（强推并留警告日志，被打断的
回合可重跑）。平台 SHALL NOT 在任何凭据可
变化的 patch 交付路径上裸调 restart 后以 catch 吞异常（生产 2026-10-24 两次「重启
platform 才生效」的事故形态）；**hot-swap 关闭或空 patch 等其余兜底 restart 路径 SHALL
同样经由控制器交付，不得绕过忙判定**。凭据行「从无到有」落库（此前该用户该线无行）SHALL
记一条审计事件（credential line created，含用户、线、时间戳）——该事件不承载密钥材料。

#### Scenario: 首行凭据在运行中的 cell 五分钟内可见

- WHEN 一个运行中的 cell（子进程已启动、此前无任何线凭据）的属主在浏览器完成首次
  铸币，且平台不重启
- THEN 交付在 5 分钟内完成（空闲立即、忙则回合边界），此后起的回合经工具发现可见
  对应线服务

#### Scenario: 兜底 restart 碰撞被重试

- WHEN 兜底路径的 restart 撞上一次进行中的 restart
- THEN 按控制器的重试节奏重试并最终交付，日志留有碰撞与重试痕迹，而非静默丢失

#### Scenario: 首行落库有审计事件

- WHEN 某用户某线的凭据行从无到有落库
- THEN 平台日志出现一条 credential line created 事件（用户/线/时间），不含 token 材料

#### Scenario: 非凭据变化维持既有交付语义

- WHEN patch 写入只是 server 增删/启停且 Authorization 头值不变、快照可比
- THEN 交付语义与本 change 之前完全一致（热交换或既有 restart 路径）

#### Scenario: 舰队回合流式中凭据变更不打断回合

- WHEN 一个舰队成员的巡逻回合正在共享子进程上流式执行，期间一次线上 token 重铸落库
  触发凭据形 patch 写入
- THEN 交付被判忙推迟（日志留 deferred 痕迹），巡逻回合完整跑完不中断
- AND restart 落在该回合终止后的最近回合边界（下一回合 pre-round 排空或排空 poller）

#### Scenario: 硬顶不吞合法长回合

- WHEN 凭据交付在某个回合开始时被判忙推迟，该回合按默认预算跑满 10 分钟
- THEN 整个回合期间不发生 restart；硬顶在该回合自行终止前不触发

#### Scenario: 非凭据兜底路径同受管辖

- WHEN hot-swap 关闭（或 patch 无服务器条目）使 profile 变更落到 restart 兜底，且此刻
  共享子进程上有在途回合
- THEN 该 restart 同样推迟到回合边界，而非立即执行

### Requirement: 同一 program 只对应一行 MCP

MCP 组合 SHALL 以 program（`command` 与其 `args`）标识「同一个服务器」，而不是以其名字。
当部署基线与打包清单以不同名字指向同一 program 时，托管 cell 的组合结果 SHALL 只包含一行；
运行期 SHALL NOT 为同一 program 拉起多于一个子进程。url 型条目无 `command`，
SHALL NOT 参与 program 判重。

#### Scenario: 托管 cell 同时有基线与 bundle 的同程序异名条目
- **WHEN** 某 cell 的 `mcp.json` 声明 `actions`、bundle 声明 `actions-mcp`，两者 `command`/`args` 相同
- **AND** 该 cell 启动
- **THEN** 组合结果只保留基线那一行（`actions`）
- **AND** 日志记一条「bundled "actions-mcp" is the same program as "actions"; skipping the duplicate」

#### Scenario: 老库已存在重复的 bundle 行
- **WHEN** 某 cell 的库里已存在同名程序的一行，且其 `origin` 为 `bundled`
- **THEN** 启动时 SHALL 删除该行并记「removed duplicate bundled …」
- **AND** 下一份 patch 里该名字不再出现

#### Scenario: 运维手工添加的同名行
- **WHEN** 同名程序的行 `origin` 非 `bundled`（运维/用户添加）
- **THEN** 该行 SHALL NOT 被删除，日志只记 skip
- **AND** 平台 MUST NOT 代替运维删除其配置

#### Scenario: 基线那份被禁用
- **WHEN** 基线的行已被管理员禁用，而 bundle 的同程序条目仍在
- **THEN** bundle 条目 SHALL 照常种入（禁用一个名字不得导致该能力完全消失）

#### Scenario: 打包/桌面形态（无 mcp.json）
- **WHEN** 部署没有 `mcp.json`（打包版），bundle 是唯一来源
- **THEN** program 判重 SHALL NOT 触发，bundle 的名字照常种入
