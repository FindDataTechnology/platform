# Tasks — add-connector-console-link

## 1. 服务端投影（独立可验收：curl 状态端点）

- [x] 1.1 `server/routes/connector.js`：上一 change（connector-credentials）已在 `connectionPayload` 投影 `connectorUrl`（origin）+ `mePath`（"/me"），本 change 零服务端改动直接复用。验证：`scripts/test-connector-credentials.mjs:545-546` 既有断言 + `probe-connector-credentials.mjs:126`

## 2. 前端入口与文案（独立可验收：卡片两态渲染）

- [x] 2.1 `web/src/components/extensions/ConnectorConnectPanel.tsx`：状态数据加 `consoleUrl` 字段；操作区渲染 `<a target="_blank" rel="noopener noreferrer">`「打开连接器控制台」，两态常显、null 时整个不渲染。验证：组件级断言（或既有扩展面板测试扩展）两态均含链接、null 态不含
- [x] 2.2 五语言 locale 键 `extensions.connector.openConsole`。验证：`check-locales` 门全绿

## 3. 回归与上线

- [x] 3.1 本地门：biome（触碰文件净）/ web tsc --noEmit / check:locales 五语言 958 键一致全绿。验证：本地门输出（e2e 走 GitHub CI，既定偏好）
- [x] 3.2 探针复验（payload 断言上 change 已在位：test:545-546、probe:126）：`scripts/probe-connector-credentials.mjs` 扩展一断言（状态端点含 consoleUrl），staging/本地跑通。验证：PROBE PASS
- [x] 3.3 上线 fd-prod（2026-10-10）：并行会话镜像捎带 9cd9de9（platform sha-61e44f7 已 Running）；后随 spawner 修复滚 sha-fcb891b。验证：线上卡片入口可见、点击新标签打开新版 `/me`
- [x] 3.4 闭环验收（2026-10-11 生产 UI 全流程实证）：深链按钮 → 新标签 connector /me → 铸 PAT → 壹座粘贴 Connected → 真回合 agent 调 `mcp__connector__list_connections` 返回 24 连接 → 撤销 PAT 后再调用 401 → 卡片翻「Re-paste needed」→ 断开复位。深链两态均渲染。
