# mcp-integration Delta

## MODIFIED Requirements

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
