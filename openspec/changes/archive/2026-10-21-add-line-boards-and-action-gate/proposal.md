## Why

谦面与萬星已经是独立产品线，各自有市场、舰队、计费和运维面；但在壹座里，用户能拿到的只有一张外链卡片（`web/src/lib/appCatalog.ts` 的 `url`）——点开就离开平台，AI 也无法代他操作。五线操作 MCP（facet-ops / facet-market / wanxing-ops）已经把动作面建好，缺的是三件互相咬合的东西：

- **看不见**：没有一个原生面呈现这两条线的状态，用户必须先离开壹座。
- **执行不了**：即使模型能调工具，写操作既没有确认也没有审计，用户不敢让它动真东西。
- **没有上下文**：悬浮对话不知道用户在看什么，只能问「你要操作什么」。

三者缺一，另外两个都没有意义：没有闸，副驾只能建议不能执行；没有看板，执行了也看不见；没有副驾，看板只是一个更小的后台。本 change 把它们作为一套交付。

## What Changes

- **线看板**：壹座为每条外部产品线提供一块原生视图（`/boards/:line`），由指标、列表、时间线三类块组成。数据经 paas 侧 **board adapter** 直连各线 REST，不经模型、不计 token。看板同时是副驾的上下文来源与动作边界——**板上没有的动作，副驾也不提供**。
- **动作闸**：新增 `propose_action` 提议通道与**动作注册表**。写类工具不再进入副驾可见面：副驾只能提议，闸按风险分级执行——读直通、写行内确认、破坏性/花钱二次确认并给影响面、对外发布走异步审批。每次执行落一条审计记录，并广播变更事件驱动看板刷新。
- **副驾**：全局悬浮入口 + 右侧 dock，**独立会话**（不写入主对话历史），携带当前看板上下文；复用现有 WS 聊天栈与工具卡体系。
- **两个官方 pack**：`谦面助手`（读工具 + 建包/发布/策展 playbook）与 `萬星舰队助手`（舰队巡检 playbook + 只读舰队工具）。两者都只声明读工具与 `propose_action`，写工具不进可见面。
- **部署动作补口**：补 `wanxing_agent_deploy`，支持 `target=desktop:<seat>`（走既有设备配对，**无需计费键**）与 `target=cloud`（需要 `wanxing-deployer` 凭据 ref）。
- **应用中心**：生态产品卡片的主行动从「打开」（外链）改为「看板」，外链保留为次要入口。

## Capabilities

### New Capabilities

- `line-boards`: 线看板——一线一板、块渲染、board adapter 契约、动作边界、事件刷新、原站深链与诚实降级。
- `action-gate`: 动作闸——动作注册表与风险分级、`propose_action` 提议通道、三级确认、影响面摘要、异步审批与超时、审计台账、部署无关的 preflight。

### Modified Capabilities

- `web-chat-ui`: 新增全局副驾面（悬浮入口 + dock + 独立会话）与看板上下文注入。
- `app-center`: 生态产品卡片的主行动改为进入线看板，外链降为次要。
- `line-credentials`: 新增 `wanxing-deployer` 长命 `sk-` 凭据 ref（仅云端部署需要；桌面机位走既有配对）。

## Impact

- `web/` — 新路由 `/boards/:line`、看板块组件、副驾 FAB/dock、动作确认卡、应用中心卡片行动
- `server/routes/` — board adapter 读端点、`/api/actions/propose`、`/api/actions/:id/approve`、审计查询
- `lib/` — 动作注册表（风险分级与影响面模板）、board adapter 接口
- `db.js` — 审批记录与审计台账（cell 本地）
- `packages/core` — 副驾会话复用现有 WS 协议；单例 store 的隔离方式在 design 决定
- `dsh-profile` / `server/ws.js` — 仅当 `propose_action` 走 dsh 工具面时需要；备选是 paas 侧 MCP server（design 决定）
- 外部仓：`wanxing-ops-mcp` 增加 deploy 工具；`facet-market-mcp` / `facet-ops-mcp` 无需改动
- 不影响现有 chat、pack 安装、萬星 facade 的既有语义
