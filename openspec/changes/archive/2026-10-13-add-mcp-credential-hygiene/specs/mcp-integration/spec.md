## ADDED Requirements

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
