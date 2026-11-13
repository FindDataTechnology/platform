# Design — add-connector-console-link

## Context

见 proposal.md（Why）。壹座侧 `ConnectorConnectPanel`（`web/src/components/extensions/ConnectorConnectPanel.tsx`）凭据状态来自 `GET /api/connector/connection`（`server/routes/connector.js`）；该路由已有 `connectorRow()`（读 `MCP_CONFIG_PATH` 的 `mcpServers.connector` 行）与 `connectorOrigin(url)`（取 origin，探活同源）。

## Goals / Non-Goals

**Goals**：凭据卡片两态常显「打开连接器控制台」入口，地址取自部署基线。
**Non-Goals**：不改凭据写入/探活/失效链路；不做登录态打通（connector `/me` 用同一 Logto，用户已登录壹座时多半免登，但不在本 change 承诺 SSO 单点体验）。

## Decisions

### D1 `consoleUrl` 走既有状态端点投影

`GET /api/connector/connection` 的响应体在既有 `connected`/`updatedAt` 等字段外加 `consoleUrl: string | null`：

```js
const row = connectorRow();
const consoleUrl = row ? `${connectorOrigin(row.url)}/me` : null;
```

- 备选 a：前端从某全局配置读 connector 域名——前端无 mcp.json 视野，硬编码域名违背「探活不硬编码」的既有纪律，否决。
- 备选 b：新端点 `GET /api/connector/console-url`——为一个字段开端点过度，否决。
- `consoleUrl` 非敏感（公开可达的用户面板地址），不受「凭据 write-only」约束——该约束针对 PAT 明文。

文件：`server/routes/connector.js`（fork 既有 change 引入的文件）。

### D2 前端按钮：两态常显、新标签、null 隐藏

`ConnectorConnectPanel` 在卡片操作区渲染：

```tsx
{consoleUrl ? (
  <a href={consoleUrl} target="_blank" rel="noopener noreferrer">
    {t("extensions.connector.openConsole")}
  </a>
) : null}
```

- 已连接/未连接两态同款（grill Q5 定案：未连接=指引终点，已连接=管理入口）；按钮文案统一，不做态区分。
- `consoleUrl === null`（基线无 connector 行，如桌面/自部署）时整个入口不渲染，指引文案退回现状纯文字说明。
- 样式沿用卡片既有按钮体系（与「断开」同列）。

### D3 locale 键

新增 `extensions.connector.openConsole`，五语言（zh「打开连接器控制台」/ en「Open connector console」/ 其余三语言按 en 语义），`check-locales` 门兜底。术语遵循 CONTEXT.md「连接器」词条（避免「connector 平台」混称）。

## Risks / Trade-offs

- [connector 与壹座不同域，新标签打开后或需再登录] → 同一 Logto（auth.finddatatech.cloud）多数情况下免登；本 change 不承诺单点（Non-goal），若实测常撞登录，后续可在 connector 侧评估静默会话探测。
- [mcp.json 行的 url 若非标准 origin 形状] → `connectorOrigin()` 既有 `new URL()` 解析已用于探活路径，坏行在探活路径早已暴露，不新增失败面。

## Migration Plan

常规 GHA→镜像→GitOps 线；无迁移、无 env。回滚 = revert 提交。部署排序在 connector `revamp-user-panel` 之后（无硬依赖，闭环验收顺序）。

## Open Questions

（无）
