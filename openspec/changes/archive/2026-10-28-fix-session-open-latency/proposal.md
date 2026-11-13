## Why

2026-10-28 真机实测（生产 sha-c4d0ce9 / sha-03687ea，台账 §15.72）：用户抱怨「打开历史对话要很久」，而 polish-web-surfaces 的挂账② 假设是「重块会话客户端挂载 3-7s，窗口 N 调参或块裁剪待实测」。这次把三段都量了，**假设被证伪**：

- **客户端不是瓶颈**：46 篇消息的 DOM 只有 1659 个节点 / 7.5KB 文本，`JSON.parse` 4ms，无 long task。渲染折叠工具块几乎不花时间。
- **阻塞一（主因）**：`GET /api/fleets` 在 cell 进程里同步占用事件循环 ~2.8s（冷启 13.6s）。根因是 N+1 —— 21 支舰队 × 60 个岗位，每个岗位都走 `resolveTarget()` → `catalog.getChatAgentEntries()` → `merged()`（重读注册表 + 已装包 + 用户预设，单次 ~30ms），60 次 ≈ 1.8s；另加每个舰队重列一遍 `cron.listJobs()`。
- **同进程：HTTP 与聊天 WebSocket 共用一个事件循环**。侧栏在**每次进页**和每 60s 轮询 `/api/fleets`，于是把 WS 握手顶在后面 —— 同一次会话切换实测「空闲 1204ms vs 轮询在飞 3911ms」。
- **阻塞二**：会话首帧 1.0–1.35MB，其中 **99.2% 是 `blocks`**（UI 默认折叠的工具载荷）；WS 未开压缩，实测 13.7KB 往返 790ms、1.17MB 往返 3896ms。

附带发现：侧栏角标读的名册行字段 `openDecisions` **该路由从未返回**（只有 fleet-architect 面有）→ 角标恒为 0，永不出现，而那 60s 轮询的实际目的就是这个角标。

## What Changes

- **名册读面单次快照**：新增 `catalog.mergedView()`（一次 merge 给出 `chatAgentEntries` + `agentEntry`）；`resolveTarget(member, view)` 接受可选快照；`GET /api/fleets`、`/api/fleets/overview`、`/api/fleets/owner/board`、`/api/fleets/:id`、`/:id/cockpit`、编排草稿校验/apply、以及 catalog 变更后的 `reconcileAllFleets`，统一改为**每请求（每轮）一份目录快照 + 一份 cron 任务表**。
- **名册行补 `openDecisions`**：`GET /api/fleets` 每行返回该舰队 open 决策数（`idx_decision_items_fleet_state` 索引计数），让侧栏角标真正工作；前端 `FleetRow` 早已声明该字段可选。
- **WS 传输压缩**：cell 的 `WebSocketServer` 开启 `permessage-deflate`（threshold 1024、no-context-takeover），首帧与后续大帧按字节压缩；网关是裸字节中继，协商在浏览器↔cell 端到端完成，**客户端零改动**。

## Capabilities

### Modified Capabilities

- `agent-fleet-core`：舰队名册读面的成本与载荷契约 —— 每请求一次目录合并；行含待拍板计数。
- `web-chat-server`：窗口化转录的**传输**契约 —— 首帧按字节压缩（折叠工具块是绝大多数字节）。

## Impact

- `catalog.js`：`mergedView()` + merge 计数探针（`catalogMergeCount()`，供测试与运维判读阻塞面）。
- `server/routes/fleets.js`：`resolveTarget(member, view)`、`taskIndexFor(fleetId, jobs)`、`rosterResolver()`；列表/overview/owner-board/:id/cockpit/草稿/apply 全部走快照。
- `server/fleet-architect.js`：`requestResolver()`（每请求一份快照）。
- `server.js`：wss 的 `perMessageDeflate`；catalog 变更 reconcile 用一份快照。
- 测试：新增 `scripts/test-fleet-roster-cost.mjs`（每请求 1 次 merge / 行含 openDecisions / view 与 live 访问器等价）。
- 兼容性：`resolveTarget` 第二参数可选（测试注入的 resolver 忽略它）；`openDecisions` 为加法字段；无协议形状变更、无客户端改动。
- rollback：revert 本变更即可（无数据迁移，无环境开关）。