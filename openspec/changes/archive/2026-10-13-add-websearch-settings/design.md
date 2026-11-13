# Design: add-websearch-settings

## Context

见 proposal.md。侦察到的既有形状（全部已核实）：

- `deployment_config`（db v19）已是"部署级 key/value，stored→env 解析"的既定模式；branding 的 `PUT /api/config/branding`（admin 门 + 空串=清除）是完整先例。
- 管理门现成：`ctx.requireMcpManage`（admin 组；hosted cell 的属主；auth 关=放行）。
- 接线消费点唯一：`dsh-profile.js` 的 `toMcpClientEntry` envRefs 解析（`scopedEnv?.[ref] ?? process.env[ref]`）。websearch-mcp 子进程只读注入后的 env，自身不改。
- 热生效现成：`ctx.dshUpdateMcp()` 重写 patch（extensions 路由每次配置变更都调它）。
- 表单缺陷属实：`McpServerForm.handleSubmit` 组装 config 时只带 `command/args/env`（stdio）或 `url/headers`（http），保存即丢 `envRefs`。

## Goals / Non-Goals

**Goals**：接线可视化可改可测；令牌不回显；未配置时行为逐字节不变；不破坏 per-cell 作用域化。

**Non-Goals**：不做 relay 侧管理（serpapi 池、配额、撤销——那是运维面，不在本分区）；不做非管理员的个人级搜索配置（搜索是部署级能力）；不改 relay/registry/dsh。

## Decisions

### D1 存储与解析：`deployment_config` 双键 + stored→env

键 `websearchUrl`、`websearchToken`。解析函数放 `lib/`（`resolveWebsearchRelay()`：stored → env → null），供路由与 dsh-profile 共用。不建新表、无迁移。

### D2 令牌 write-only

GET 只回 `{ url, hasToken, tokenHint: "…abcd", source: {url: "stored"|"env"|null, token: ...} }`。PUT 对 token 的特殊语义：字段缺失=不动；`""`=清除；非空=覆盖。日志与错误信息永不含令牌值。

### D3 与 scoped 派生的关系

设置面存的是"该部署可用的兜底令牌"（通常仍是静态 relay token 或留空吃 env）。写 patch 时既有优先级不变：`SEARCH_RELAY_SCOPED_MASTER` 在场 → 派生值覆盖一切；否则 `storedToken ?? env` 注入。即存储值永远不是"绕过派生"的旁路，只在无 master 部署里替代 env 的兜底角色。

### D4 连通性测试：服务端代发，不落盘

`POST /api/config/websearch/test` 接 `{ url?, token? }`（缺省=生效值），服务端向 `<url>/v1/search` 发一条 `num:1` 最小查询，5s 超时，返回分类结论：`ok`(200) / `auth-rejected`(401/403) / `upstream-degraded`(5xx，如实标注池干涸等) / `unreachable`(超时/连接失败) / `invalid-url`。服务端代发而不是浏览器直连：浏览器在 cell 网络里到 relay 的路径与服务端不同（127.0.0.1 绑定），且避免 CORS 面扩大。

### D5 表单 envRefs 保留 + bundled 指引

`McpServerForm` 增加"未建模字段透传"：编辑态保存时以原 config 为基底 merge 表单字段（而非重建）。websearch 行（`origin: bundled` 且 name=websearch）在编辑表单顶部渲染提示"接线在设置→网络搜索"，并保留其 envRefs 不动。实现取最小面：保存时 `config = { ...originalConfig, ...formFields }`，删除字段需显式（表单没有删除语义，故无破坏）。

### D6 分区注册与 i18n

`sections.ts` 注册 `websearch`（Capabilities 组、`adminOnly: true`、图标 `Globe`）、五语 locale 各加 `settings.sections.websearch` 与 `settings.websearch.*` 文案组（check-locales 会强制五语齐全）。adminOnly 与后端门一致（auth 关时全可见，同 branding 模式）。

## Risks / Trade-offs

- **令牌落 DB**：与 registry/connector 凭据同库同密级（都是 0600 库文件+同主机），不引入新暴露面；比 env-in-patch 面更小（不再进 GitOps 清单）。
- **测试端点成为 SSRF 面**：仅管理员可达；只允许 http(s) 且向 `<url>/v1/search` 发固定形状请求——与既有 chart replay 的 MCP 出站同类，且管理门后，可接受。
- **未保存即测试**：按 D4 用表单值直测，不写库；保存后热重写 patch，无需重启（与 extensions 编辑同路径）。
