## Context

见 `proposal.md` — Why。设计前已核实的现状（代码级证据）：

- 三个列表面各自持有组件内 state，初值为空（`FleetsPage.tsx:241` `[]`、`AppCenterPage.tsx:243` `null`、`AgentsPage.tsx:44` `[]`），**没有 loading 态**，首帧即渲染空态文案（`FleetsPage.tsx:578/607`；应用中心 `apps=null` 时只渲染 `APP_LINES` 的 5 张静态品牌卡，`appCatalog.ts:25-64`）。
- 每次挂载都重新 fetch（`FleetsPage.tsx:311-313`、`AppCenterPage.tsx:263-265`、`AgentsPage.tsx:157-172`），无任何客户端缓存；`selectedId` 也是组件内 state，切页即丢。
- 智语未读计数 = `gateway/zhiyu/store.js:477`（`read_at IS NULL` 计数）；唯一置读路径 = `index.js:655` `POST /api/zhiyu/notifications/:nid/read`；**全仓无客户端调用**。通知面板把 `type === "invite"` 过滤掉（`ZhiyuPage.tsx:79`）而计数包含 invite；接受/拒绝邀请（`index.js:554`）不置读其通知。
- 长会话打开：`perf-session-open` 已上客户端三件套（乐观切换 + `sessionCache` + 渲染开窗），并把服务端载荷裁剪列为 deferred non-goal。服务端仍 `switchToSession`（`server/agent-session.js:148`）→ `getSession`（`chat-history.js:477`）→ `getChatMessages` 取全量并 `JSON.parse(blocks)`（`db.js:1082`）→ `ws.js:1088+` 一帧推整段。
- 现成可复用的事件：`catalog_changed`（`catalog.js` 广播，`AgentsPage` 已用它触发刷新）、服务端已有的 list 读面失败自愈重试（`FleetsPage.tsx:288-303`）。

## Goals / Non-Goals

**Goals:**
- 消除列表面的「空态闪屏」与「每次进入重拉」：首帧不出现空态文案，二次进入即时渲染。
- 让智语未读角标有确定的归零路径，且计数与可见条目口径一致。
- 让长会话打开的载荷与「实际渲染的量」对齐，使打开时长不再随会话长度线性增长。

**Non-Goals:**
- 不改列表面的业务语义与卡片/条目形态。
- 不引入第三方数据获取库（react-query/SWR）——保持零新增依赖。
- 不做真正的 transcript 虚拟化、不改 dsh 运行时。
- 不为 `/api/catalog` 增加服务端缓存层（本轮只做客户端侧；服务端耗时另计）。

## Decisions

### D1: 列表面缓存用「内存 + 后台 revalidate」的小工具，不引库
新增 `web/src/lib/listCache.ts`：一个进程级 `Map<key, {data, at}>` + `useListCache(key, fetcher)` 钩子，返回 `{data, status, refresh}`，`status ∈ idle|loading|loaded|error`。挂载时若命中缓存：`status` 立即为 `loaded`（用缓存渲染）并在后台 revalidate；未命中则 `loading`，完成后 `loaded`。
- 备选：sessionStorage 持久化（跨刷新也即时，但需处理序列化/版本失效，收益边际）；引入 SWR/react-query（能力过剩、增依赖）。
- 理由：五个端点（`/api/catalog`、`/api/connections`、`/api/fleets`、`/api/clusters/mine`）都是小载荷、可重取；内存级足以消灭「每次进入重拉」，且不引依赖。

### D2: 空态只在 `loaded && empty` 时渲染
每个列表面把「空/非空」判定改为先判 `status === "loaded"`；`loading`（且无缓存）时渲染骨架或留白。应用中心的产品区在冷启动给槽位骨架，避免「5 张静态品牌卡看起来已加载完」再突增。
- 备选：只在有缓存时即时渲染、其余保持现状（不解决首次进入的空态）——否决，用户抱怨的正是首帧。

### D3: 集群页记忆上次选中
选中 id 持久化到 `localStorage`（键如 `fleets.lastSelectedId`）。进入 `/fleets`（无路由 id）时，若有记忆且该集群仍存在，则恢复选中；不存在则忽略。路由 `/fleets/:fleetId` 仍是权威（深链优先）。
- 备选：自动选中列表第一项（会在用户想「无选中」时强行选中）——否决。

### D4: 智语置读走「进页全清 + 邀请动作置读」，服务端加一个 bulk 端点
- 服务端新增 `POST /api/zhiyu/notifications/read-all`：一条 `UPDATE ... WHERE email=? AND read_at IS NULL`，返回新 `unread`；保留 per-nid 端点。
- 客户端：`ZhiyuPage` 挂载即调 `read-all`，并用返回值立即清零角标（`setZhiyuUnread(0)`），不等 Sidebar 的 60s 轮询。
- `resolveInviteAction`（接受/拒绝）在解决 invite 行后，同时把该房间对该用户的 invite 通知置读。
- 口径一致：通知面板不再过滤 `invite`（改为显示），与未读计数口径对齐；`Sidebar` 的角标继续读 `notificationUnreadCount`。
- 备选：逐条 per-nid 客户端循环置读——N 次往返且与面板滚动竞态；「打开来源房间才清」——覆盖不到 call/minutes/budget。均否决。

### D5: 长会话载荷——先测量，采用「窗口化 session_loaded + 按需加载更早」为默认方案
- 先插测量：`switchToSession` 记录耗时与 `messages` 序列化字节数（日志一行，便于真机取数）。
- 默认实现（测量确认瓶颈在载荷后即落地）：`session_loaded` 首帧携带**最近 N 轮**（N 与客户端渲染开窗一致，取 50）+ `hasMore` 标志 + 总数；新增按需 `load_earlier`（游标为最早已载消息的 seq），客户端在顶部「加载更早」时拉取上一页。
- 备选：metadata-first（先发标题/计数再发正文，两次往返，交互更繁琐）；重块裁剪（把 tool 产物/artifact 从首帧剔除，但客户端渲染需要它们、会引出二次拉取）。默认方案与既有开窗天然对齐，且老客户端忽略 `hasMore` 时退化为「只见最近 50 轮」，风险可控。

## Risks / Trade-offs

- [缓存陈旧] → 后台 revalidate + 复用 `catalog_changed` 事件失效 + 窗口 focus 重取；缓存条目有界。
- [现有 e2e 断言「空文案立即出现」会红] → 一并更新这些断言为「加载完成后出现」；新增空态时序用例。
- [session_loaded 载荷变化影响旧客户端] → 字段只加不改；首帧仍含最近 50 轮，未升级客户端退化为窗口视图而非报错。
- [置读与多标签并发] → 服务端单次 UPDATE，前端以接口返回的 `unread` 为准（非本地推算）。
- [客户端缓存与 per-user 可见性（role-filtered catalog）] → 缓存键含用户身份/role 摘要，登出或身份变化时清空缓存。

## Migration Plan

无数据库迁移。web 包与 gateway/server 同批出片（缓存是纯前端，置读 bulk 端点需服务端同代；若服务端先行、前端未更新则仅 Beta 不生效，无破坏）。回滚 = 回滚镜像。

## Open Questions

- N（首帧载荷轮数）是否定 50 还是随渲染开窗常量共用一处定义——留待与 `perf-session-open` 的开窗常量对齐时定，不影响规格与任务拆分。
