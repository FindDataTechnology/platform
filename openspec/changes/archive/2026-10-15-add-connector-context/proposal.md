# add-connector-context

## Why

壹座侧用户在「点击连接」前后缺少产品上下文：

1. **MCP 市场页的 connector 凭据卡片**只有标题与状态，没有说明这是什么产品；用户点「连接新账号」后弹窗直开 OIDC 授权页——第一次连接的用户在整条路上都看不到「连接器是什么、令牌做什么用」。
2. **应用中心的「萬星·连接器」卡片描述漂移**：现文案「数据连接器——连接企业数据库与外部数据源」与实际产品（SaaS 连接网关、统一凭据托管、为 agent 铸令牌）不符，且卡片落点是连接器根路径（本次配套修复后导流到欢迎卡）。

## What Changes

- **凭据卡片加上下文**：`ConnectorConnectPanel` 在标题下加一句产品说明与「了解产品」链接（新标签 → 官网产品介绍页，按界面语言选页），让用户在点「连接新账号」之前知道这是什么、令牌给谁用。
- **应用中心卡片纠偏**：`agents.json` 中 `wanxing-connector` 条目的 description 对齐产品实际口径；卡片 url 维持连接器根路径（导流后透明到达欢迎卡，不硬编码 `/me`）。
- **五语 locale 全配**：新键在 en / zh-CN / ja / fr / es 同步（`check-locales` 门兜底）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `connector-credentials`：「Settings panel entry for the connector credential」要求增加卡片上下文——标题下常显一句产品说明与「了解产品」链接（按界面语言选官网页，新标签）。

（应用中心卡片描述纠偏是 `agents.json` 内容编辑、无行为变化，不产生 spec delta——app-center spec 不动。）

## Non-goals

- 不改连接器侧任何行为（欢迎卡/导流由 open-connector-mt `add-welcome-entry` 承担）。
- 不改 zero-paste 弹窗行为（直开 OIDC authorize 的既有决策不动）。
- 不改已登录 `/me` 面板。
- 不做应用中心卡片结构改版；只纠描述文案与新增卡片上下文。

## Impact

- 前端：`web/src/components/extensions/ConnectorConnectPanel.tsx`（标题下说明 + 链接）、`web/src/locales/*/common.json`（五语言新键）。
- 配置：`agents.json`（wanxing-connector description 纠偏；生产 `/api/catalog` 的 apps 数组单源于镜像内该文件——已实证 `AGENTS_CONFIG_URL` 覆盖的远端只有 agents 数组、无 apps，故改此处即达生产）。
- 无数据库 / profile / dsh 改动。
- 部署顺序：晚于 open-connector-mt `add-welcome-entry` 上线（「了解产品」链接与卡片落点与该 change 的欢迎卡互为闭环；互无硬依赖）。
- 验收：组件测试（说明文案与链接断言）+ `check-locales` 门 + 既有套件全绿 + 线上实机（面板文案可见、「了解产品」可达官网页）。
