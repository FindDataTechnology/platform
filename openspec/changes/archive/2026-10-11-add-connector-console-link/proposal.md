# add-connector-console-link

## Why

壹座 MCP 市场页的 connector 凭据卡片（`ConnectorConnectPanel`）已用文案指引「PAT 从 connector 的『我的连接』页面获取」，但没有任何跳转入口——用户需要手动开新标签、输域名、再登录，指引断在最后一步。connector 侧的页面重排（open-connector-mt `revamp-user-panel`）会把 PAT 铸造卡变成登录后的第一焦点，壹座侧补上深链后即可形成「点按钮 → 铸 PAT → 回来粘贴」的闭环。

## What Changes

（以下为 2026-10-10 grill 定案；术语按 CONTEXT.md 用「连接器」）

- `ConnectorConnectPanel` 增加「**打开连接器控制台**」按钮：**未连接与已连接两态都显示**（未连接态是指引终点、已连接态是管理入口——撤销 PAT、增删连接都要去那里），新标签打开（`target="_blank"`）。
- 目标地址 = 部署基线 connector 服务行的 origin + `/me`：`server/routes/connector.js` 已有 `connectorRow()` / `connectorOrigin()`（粘贴探活同一来源，不硬编码域名）；基线无该行时按钮隐藏，降级为纯文案指引。
- 服务端在既有凭据状态端点投影中透出 `consoleUrl`（前端不自行读 mcp.json）。
- 五语言 locale 键同步（`check-locales` 门）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `connector-credentials`：「Settings panel entry for the connector credential」requirement 增加深链行为——两态常显「打开连接器控制台」入口，URL 取自部署基线 connector 服务行（不硬编码），基线缺行时入口隐藏。

## Impact

- 前端：`web/src/components/extensions/ConnectorConnectPanel.tsx`（按钮 + 两态展示）、`web/src/locales/*`（五语言键）。
- 服务端：`server/routes/connector.js`（状态投影透出 `consoleUrl` = `connectorOrigin(row.url)` + `/me`）。
- 无数据库 / profile / dsh 侧改动；凭据写入-校验-失效链路不变。
- 部署顺序：晚于 open-connector-mt `revamp-user-panel` 上线（互无硬依赖——深链打开的 `/me` 在旧版上也活着；排序只为闭环验收一次走通）。
