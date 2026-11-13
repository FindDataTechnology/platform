## Why

五个用户可见的打磨缺陷集中在「web 列表面的数据获取」与「智语未读回路」两处：三个列表面（集群 / 应用中心 / 智能体）每次进入都先闪空态文案再重拉（无客户端缓存，且把「加载中」当「空」渲染）；智语未读角标没有任何客户端调用置读接口，一旦产生过通知就永久挂数；长会话打开慢的真正原因（首帧整段 transcript）在上一轮 `perf-session-open` 里被明确列为 non-goal 推迟，那一轮只优化了客户端挂载。

## What Changes

- **列表面加载语义**：引入共享的「加载态 vs 空态」区分与客户端缓存（stale-while-revalidate）。首帧不再渲染空态文案；二次进入用缓存即时渲染、后台 revalidate。覆盖应用中心、智能体页、集群页。
- **集群页记住选择**：返回集群页时恢复上次选中的集群（路由已支持 `/fleets/:fleetId`），不再每次都显示「选择或创建一个集群」。
- **智语未读回路接通**：进 `/zhiyu` 即把当前未读通知全部置读；接受/拒绝邀请时同时置读其通知；未读计数与通知面板口径一致（invite 要么面板可见、要么不计入）；前端置读后立即本地清零，不再依赖 60s 轮询。
- **长会话打开**：`session_loaded` 首帧不再携带整段 transcript。先插测量（服务端 `switch_session` 耗时 + 载荷字节数），再在 metadata-first / 分页 `session_loaded` / 重块裁剪三者中选定一种（设计阶段定）。

## Capabilities

### New Capabilities

- `web-list-surfaces`: web 列表面的加载态与客户端缓存行为——空态只在加载完成后出现（不闪屏）、列表读取走客户端缓存 + 后台 revalidate、列表面记住上次选择。

### Modified Capabilities

- `zhiyu-room`: 「通知与触达」——未读角标必须可归零（置读回路 + invite 口径一致 + 置读后即时清零）。
- `web-chat-server`: `session_loaded` 首帧不携带整段 transcript——长会话打开的载荷有界或可按需加载。
- `web-chat-ui`: 长会话打开的读面配合——如需「加载更早」入口则在此声明，否则沿用既有缓存/开窗行为。

## Impact

- **Code**: `web/src/pages/{AppCenterPage,AgentsPage,FleetsPage}.tsx`、`web/src/components/Sidebar.tsx`、`web/src/pages/ZhiyuPage.tsx`、`gateway/zhiyu/{index.js,store.js}`、`server/ws.js`、`server/agent-session.js`、`chat-history.js`/`db.js`；新增一个共享列表面缓存工具（`web/src/lib`）。
- **APIs**: 新增 `POST /api/zhiyu/notifications/read-all`（置读量一条 UPDATE，保留既有 per-nid 端点）；WS `session_loaded` 载荷形态变化，字段只加不改（向后兼容）。
- **依赖**: 无新增第三方依赖。
- **Non-goals**: 不改列表面的业务语义；不动 `/api/catalog` 的对外契约；不做 transcript 虚拟化（沿用 `perf-session-open` 的开窗）；不动 dsh 运行时。
