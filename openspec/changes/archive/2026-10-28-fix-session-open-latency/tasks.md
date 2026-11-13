## 1. 名册读面单次快照（catalog）

- [x] 1.1 `catalog.mergedView()`：一次 `merged()` → `{ chatAgentEntries, agentEntry(id) }`（语义与 `getChatAgentEntries()` / `getAgentEntry()` 等价，含 apiKey 解析）
- [x] 1.2 `catalog.catalogMergeCount()` 探针（测试与运维判读阻塞面）
- [x] 1.3 `server/routes/fleets.js`：`resolveTarget(member, view = null)`；`taskIndexFor(fleetId, jobs = cron.listJobs())`；`rosterResolver()`（每请求一份快照）
- [x] 1.4 `GET /api/fleets`：一份快照 + 一份 job 表 + 一份 modelCtx
- [x] 1.5 `GET /api/fleets/overview`、`GET /api/fleets/owner/board`：同形状改造（两处都曾逐岗位合并 + 逐舰队列 job）
- [x] 1.6 `GET /api/fleets/:id`、`GET /api/fleets/:id/cockpit`：同形状改造
- [x] 1.7 编排草稿校验 / apply（cockpit 面）改用 `rosterResolver()` 产出的 resolver
- [x] 1.8 `server/fleet-architect.js`：`requestResolver()` 每请求一份快照（draft/apply）
- [x] 1.9 `server.js`：catalog 变更后的 `reconcileAllFleets` 用一份快照（60 岗位曾是 60 次合并）
- [x] 1.10 （实测追加）`server/fleet-reconcile.js`：`cronPeriodMs` 按 (cron, tz, 日) 记忆化——实测发现名册读真凶是带时区的 cron 解析（40ms/次 × 岗位 × 2-3 次询问），比目录合并更重；spec 补「节奏周期计算按 (cron, 时区) 记忆化」需求

## 2. 名册行补待拍板计数

- [x] 2.1 `GET /api/fleets` 每行返回 `openDecisions`（`db.countOpenDecisions`，索引计数）
- [x] 2.2 侧栏角标链路打通（前端无需改动，`FleetRow.openDecisions` 早已声明）

## 3. WS 传输压缩

- [x] 3.1 `server.js` 的 `WebSocketServer` 开启 `perMessageDeflate`（threshold 1024、双 no-context-takeover）
- [x] 3.2 确认网关裸字节中继不破坏协商（`forwardedHeaders` 透传 `sec-websocket-extensions`，`proxyUpgrade` 双向 pipe）

## 4. 测试与验证

- [x] 4.1 `scripts/test-fleet-roster-cost.mjs`：每请求 1 次 merge（24 岗位）/ 行含 openDecisions / `mergedView` 与 live 访问器等价
- [x] 4.2 既有 fleet 套件回归：core 20/20、architect 11/11、failing-status 7/7、owner-surface 9/9、decision-lane 10/10、ops-canvas 6/6；orchestration 3 失败在 HEAD 同样复现，非本变更引入
- [x] 4.3 语法检查（`node --check`）四个改动文件
- [x] 4.4 openspec validate --specs（202/0）+ change archive 绿
- [x] 4.5 出片（GHA 公开线 sha-25d7244，digest fa93f154）+ GitOps bump（platform×2）+ ArgoCD 滚版
- [x] 4.6 生产复测：`/api/fleets` 2065-4110ms → **110-170ms**（22 行全带 openDecisions，合计 66）；WS 切换重会话 1204→763ms、轻会话 790→347ms；wire 字节同载荷 482→156KB（3.1×）；`Sec-WebSocket-Extensions` 端到端协商实证（101 响应带 permessage-deflate; no-context-takeover）；侧栏角标首次渲染（集群 66）
- [ ] 4.7 台账 §15.73 + 记忆落盘