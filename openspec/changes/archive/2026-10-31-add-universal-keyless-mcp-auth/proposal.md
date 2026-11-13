## Why

功能集要卖进主流市场（Claude Code、Cursor、ZCode、Codex CLI、Gemini CLI、WorkBuddy/CodeBuddy、
VS Code、Windsurf、Cline、Continue、Zed、JetBrains、Claude Desktop……），但每个套件的数据面都要过
**我们的**基础设施鉴权。今天用户在 WorkBuddy 上装完套件仍被要求「打开注册处、复制一串 `wgk-` 密钥、
粘回客户端」——这是漏斗杀手，且**逐个客户端手工适配**已经证明行不通：

2026-10-30/31 的两次实测把一个假设钉死了：

- **服务端免键车道完全可用**：静态 client_id + PKCE 全链，token `aud` 命中、`initialize` 200、
  `tools/list` **161 个工具**（生产端点，真登录）。
- **但客户端会不会用它是另一回事**：WorkBuddy 5.9.3 的用户级 `mcp.json` 加载器**丢弃** `oauth` 块
  （`parseMcpServerEntry` 不解析、`UserMcpProvider → toAuth$2` 只递 `provider:{name}`），于是回落到
  动态注册（我们无 DCR）→ `Incompatible auth server`；而同一个客户端的**连接器/市场模板**路径
  **确实消费** `oauth.clientId`。同一份「标准」，两条加载路径两种结局。

结论：**不能设计成"等某个客户端配合"**。要一套方案，让任何客户端都不必改、用户永远不必看见密钥。

## What Changes

- **三道并存**：L1 原生 OAuth（客户端自己走授权，零凭据落盘）／**L2 代持令牌**（CLI 走授权、把短令牌
  写进客户端**必然支持**的静态 headers）／L3 调用键（headless/CI 与降级）。CLI 按能力表自动选道。
- **能力表 + 自动探针**（方案地基）：每客户端 × 版本记录三项机器实证事实（静态 header 是否被采纳、
  `oauth.clientId` 是否进 SDK provider、是否支持 DCR），由 `scripts/probe-mcp-auth-lanes.mjs` 生成；
  版本变动即标记 stale 并降级到 L2，**不静默失败**。
- **服务端补齐 refresh_token**：现状实测 scope 为空且无 refresh_token → L2 会退化成每 8h 人工重授权，
  不算解决。修授权请求（`offline_access` + `prompt=consent`）、开启 rotation、查清 scope 协商。
- **市场产物带分客户端连接块**：`plugins/<pack>/connect/<client>.{json,md}`，让「装完怎么连」对
  每个宿主客户端都是**一步命令**，而不是一段要用户自己拼的 JSON。
- **修正主 spec 与事实冲突的一条**：`ecosystem-access` 现写「授权服务器文档 SHALL 暴露注册端点」，
  而我们的 Logto **没有** DCR，且 MCP 规范已把 DCR 降为 MAY 并在 2026-07-28 版弃用。改为
  「静态 client_id 与 discovery 并列支持，DCR 非必需」。

## Capabilities

### New Capabilities

- `mcp-auth-lanes`：跨客户端免键接入的道选择、能力表与探针契约、以及"已解决"的判据。

### Modified Capabilities

- `ecosystem-access`：「Native OAuth discovery connection is supported」——删去对 `registration_endpoint`
  的硬性要求，改为静态 client_id 优先、DCR 可选。
- `facet-editor-cli`：「MCP references are honest about credentials」——新增 L2 代持令牌写入与
  `facet auth --refresh`，并规定 CLI 必须按能力表选道并如实播报道状态。

## Impact

- 代码：`facet/cli/facet.js`（`auth` 子命令、选道逻辑）、`facet/mcp-auth-capability.js`（新）、
  `scripts/probe-mcp-auth-lanes.mjs`（新）、`facet/marketplace-repo.js`（`connect/` 产物）。
- 身份侧（生产 Logto）：授权请求加 `prompt=consent`、native 应用开 rotation、scope 协商排查。
- 测试：能力表契约测试、探针离线夹具、CLI 选道单测、`connect/` 产物形状断言。
- 不改任何客户端代码；不引入伪造 DCR 的授权代理（规范已弃用 DCR，固化成架构债）。
- 风险：L2 的令牌是用户身份代理物，权限面宽于 scoped 调用键 → 用短有效期 + 0600 + 不落 refresh token
  + 可吊销压风险；有 L1 的客户端一律优先 L1。
