## 1. 列表面：加载态与客户端缓存（web-list-surfaces）

- [x] 1.1 新增 `web/src/lib/listCache.ts`（进程级 `Map` + `useListCache(key, fetcher)`，返回 `{data, status, refresh}`，`status ∈ idle|loading|loaded|error`），并写单测覆盖：冷启动为 loading、命中缓存即时为 loaded 且后台 revalidate、失败落到 error。验证：`scripts/test-list-cache.mjs` 8/8 通过。
- [x] 1.2 应用中心接入：目录产品区在冷启动渲染占位骨架（不再「5 张品牌卡 → 突增」），缓存命中时即时全量渲染。验证：e2e `app-center.spec.js`「a revisit paints the catalog in full from cache」通过（切走再返回无骨架帧）。
- [x] 1.3 智能体页接入（`/api/catalog` + `/api/clusters/mine`），空态文案只在 `loaded && empty` 出现。验证：e2e `agents-smoke.spec.js`「a delayed cluster read shows no empty copy until it lands」通过。
- [x] 1.4 集群页接入（`/api/fleets`）：新增 loading 态，列表空文案仅在 `loaded && empty` 出现。验证：e2e `fleets.spec.js`「cold load shows placeholders, never the empty copy」通过。
- [x] 1.5 缓存失效接线：`catalog_changed` 广播使 catalog 缓存失效并重取；窗口 focus 触发重取；身份/角色变化或登出清空缓存。验证：`test-list-cache.mjs` 覆盖 invalidate（精确/前缀）、订阅通知、clear 全清；接线在 `App.tsx`（identityKey → clear，catalogVersion → invalidate「catalog」）。
- [x] 1.6 集群页记住上次选中（`localStorage` 键 `fleets.lastSelectedId`），深链 `/fleets/:fleetId` 优先、记忆的集群不存在时忽略。验证：实现 + `fleets.spec.js` 全组通过（列表/详情/深链不回归）。
- [x] 1.7 更新既有断言「空态文案立即出现」的用例为「加载完成后出现」，并补一条空态时序用例。验证：`app-center.spec.js` 加骨架归零等待；新增集群页/智能体页两条时序用例，均通过。

## 2. 智语未读归零（zhiyu-room 通知与触达）

- [x] 2.1 服务端新增 `POST /api/zhiyu/notifications/read-all`（一条 `UPDATE ... WHERE email = ? AND read_at IS NULL`，返回最新 `unread`）。验证：`scripts/test-zhiyu-notify.mjs` 8.3（read-all 归零、幂等、不动他人）通过。
- [x] 2.2 接受/拒绝邀请时置读其对应通知（`resolveInviteAction`）。验证：`test-zhiyu-notify.mjs` 8.1（accept 后该用户 unread 归零）通过。
- [x] 2.3 未读计数与通知面板口径一致（面板不再过滤 `invite`，与计数同集合）。验证：e2e `zhiyu-unread-badge.spec.js`「an invite-only unread badge ... has a matching panel row」通过。
- [x] 2.4 前端进 `/zhiyu` 调用 `read-all` 并以返回的 `unread` 即时清零导航角标（不等 Sidebar 轮询）。验证：同上 e2e（`readAllCalls > 0` 且角标消失）。

## 3. 长会话打开载荷（web-chat-server / web-chat-ui）

- [x] 3.1 插测量：`switchToSession` 记录耗时与 `messages` 序列化字节数（一行日志）。验证：生产真机读数 `[session-open] switch cron-job_1793138268104_ixzde6 ms=137 messages=51 bytes=1710034`——服务端切换 137ms、首帧被窗口钉在 51 条/1.7MB（该会话全量 54 条；字节≈33KB/条，重块为主），窗口化生效。
- [x] 3.2 服务端首帧窗口化：`session_loaded`（`running: false`）只携带最近 N 轮 + `totalTurns` + `hasMore`；N 与客户端渲染开窗共用同一常量（`TRANSCRIPT_WINDOW = 50`）。验证：`test-transcript-window.mjs` 6/6 + e2e `session-open.spec.js`「a long session loaded from the server opens windowed」通过。
- [x] 3.3 服务端按需分页：新增 `load_earlier`（游标 = 最早已载 `seq`，返回上一批升序 + `hasMore`），复用 `switch_session` 的所有权校验。验证：`test-transcript-window.mjs` 逐页回溯/最老页终止/空页如实/未知输入降级 全通过。
- [x] 3.4 客户端接入：store 持有已载窗口；顶部「加载更早」改为向服务端取上一页并前插；已含首轮时隐藏入口；outline/export 不报错。验证：`test-chat-store-session-open.mjs` 3.4（前插 + 游标推进 + 异会话丢弃）4 例通过；e2e `session-open.spec.js` 渲染开窗/outline 跳转全通过。
- [x] 3.5 老客户端兼容回归：未知字段（`hasMore`/`totalTurns`）到来不报错、按窗口替换。验证：`test-chat-store-session-open.mjs` 3.5（无计数字段的旧负载读作完整）通过；session/store/history 相关 42 例全通过。

## 4. 收口与出片

- [x] 4.1 新增文案（加载中/骨架等）补齐五语言，复用既有「加载更早」。验证：`check:locales` 五语言全 OK（es/fr/ja 补译 53 key，镜像构建硬门实证拦下后补齐）。
- [x] 4.2 全量门：`npm run test:unit` 与相关 e2e 全绿。验证：本变更 4 测试文件 33/33 + session/store/history 域 42/42；e2e `session-open` 全过 + 新增 `zhiyu-unread-badge`/`agents` 延迟读/`fleets` 冷启动三条时序用例通过（app-center GRID_ORDER 一例红为 HEAD 既有：`agents.json` 已含 `crm-desk` 而期望表未更新，与本变更无关）。
- [x] 4.3 `openspec validate --specs` 全量为 0 失败。验证：`190 passed, 0 failed`。
- [x] 4.4 出片并真机眼见五项（集群空态不闪、应用中心即时全量、智能体不空刷、智语角标可归零、长会话打开变快）。验证（生产 `platform.finddatatech.cloud`，镜像 sha-bbe86c4/digest 5fc4479d，aloadtree 会话实走）：
  - #4 角标：进页前 45 → 进 `/zhiyu` 后侧栏角标元素 0 个且不再复现；动静面板可见邀请类通知（口径一致同屏可见）。
  - #1 集群：首访 loading 占位（`fleets-loading=1`）全程无空文案；列表落地 21 卡；选中→切走→切回，卡片高亮恢复且「选择或创建一个集群」0 次。
  - #2 应用中心：冷加载即全量 22 卡（骨架窗口小于采样粒度），回访零骨架、产品卡即时在位。
  - #3 智能体：加载中无空态闪现，落地后诚实空态（「还没有阵列…」）正常呈现，回访 60 专家卡即时。
  - #5 长会话：窗口化实证（50 条挂载 + load-earlier 按需翻页 50→54、最老页按钮消失；in-pod drill 证 total=54/hasMore=true/分页 4 条）；缓存回访 ~0.9s 无骨架即时渲染；服务端探针 137ms/1.7MB。已知余量：重块会话（≈33KB/条）客户端挂载仍 3-7s，属 N 调参与块裁剪的后续优化空间，台账挂账。
