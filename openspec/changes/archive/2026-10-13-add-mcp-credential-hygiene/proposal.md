# Proposal: add-mcp-credential-hygiene

## Why

每个 cell 的 `mcp.patch.yml` 以默认权限（0644）明文携带两类凭据：http 型 server 的 `headers.Authorization`（resolveCredentials 在写盘前物化的用户 registry key）与 stdio 型 server 的 envRefs 解析值——其中 `SEARCH_RELAY_TOKEN` 是**平台级**共享秘密（websearch 属部署基线，全 cell 的 patch 都含它）。2026-10-13 micro-presets 排查实录证明任何会话一句 `cat` 即可取走（两值已进过一次会话记录，token 当日已轮换止损，但结构性暴露仍在）。同时 MCP 装包链路失败完全静默：`failOnStartupError: false` 把 401/503 全部吞成"配置里有、工具里没有、哪里都不报错"（§4.7 双静默实录：wgk- 401 + daas-mcp 503）。

## What Changes

- **平台秘密 per-cell 作用域化（治爆炸半径）**：search-relay 增加无状态 HMAC 派生令牌（master secret + cell/租户标识 → 可鉴权、可归因、可吊销的单 cell 令牌）；host 侧按 cell 派生注入，取代全平台共享的单一 `SEARCH_RELAY_TOKEN`。泄露面从"平台"缩到"单 cell"，吊销不伤他人。
- **patch 文件权限收紧（纵深防御）**：`atomicWriteTextSync` 支持 mode 参数，MCP patch（及同类凭据承载文件）落盘 0600。
- **MCP preflight 可观测**：host 在装包/写 patch 的组合时刻用与 dsh 相同的 URL+headers 探活各 http 型 server，结果落 store 并经诊断端点暴露；`failOnStartupError` 维持 `false`（dsh-mcp-client 源码证实置 true 时 `registrationFailure: "throw"` 在 plugin apply 抛出——单个抽风上游会砸掉整个会话启动，风险不可接受），失败改为在平台侧显形。
- **明确不动**：不改 dsh-mcp-client（其 streamable-http 分支对 `config.headers` 原样透传、无 ref/插值机制，fork 成本与维护负担不成比例）；stdio envRefs 的"值进 patch"行为保留（per-cell 化后该通道不再承载平台级秘密）。

## Capabilities

### New Capabilities

- `scoped-relay-credentials`: search-relay 的作用域令牌鉴权——无状态派生（HMAC(master, scope-id)）、令牌自带归因前缀、按 scope 吊销（denylist）、静态 `tokens` 列表继续并行支持（平滑迁移）。

### Modified Capabilities

- `mcp-integration`: 新增两条 requirement——① MCP patch 文件凭据卫生（0600 权限；平台级共享秘密不得作为 cell patch 的注入值）② MCP server preflight 健康信号（装包/写 patch 时探活，失败在诊断端点与日志可见，替代翻 `failOnStartupError` 的破坏性方案）。

## Impact

- `services/search-relay/index.js`：令牌校验从 `tokens.includes` 扩展为静态列表 ∨ HMAC 派生 + denylist；keys.json 结构不动。
- `dsh-profile.js`（writeMcpPatch/toMcpClientEntry/atomicWrite 调用点）与 `lib/persistence.js`（writeViaTemp 增加 mode）：权限与 per-cell 令牌解析注入。
- cell 侧 host 进程：为每个 cell 派生 relay 令牌（派生发生在写 patch 时，值仍会落该 cell 的 patch——但已是单 cell 作用域，这正是设计取舍）。
- 运维：迁移期静态 `tokens`（含 2026-10-13 新轮换值）保留为兜底；部署顺序 = 先滚 relay（接受两种令牌）再滚 platform。
- 不改 dsh 镜像、不改 dsh-mcp-client、不改 registry。
