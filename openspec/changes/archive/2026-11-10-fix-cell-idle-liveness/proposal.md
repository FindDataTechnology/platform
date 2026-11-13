# fix-cell-idle-liveness

## Why

`scripts/test-cell-gateway.mjs` 的 WS 断言**偶发**失败（两次不同断言：304 行"重启的 cell 必须
通过代理 WebSocket 回 sessions"、314 行"用户 B 必须拿到自己的 connect-time sync"），每次都是
`waitForFrame(..., 90_000)` 把 90 秒耗尽。看起来像 WS 代理坏了，实际上**cell 侧从来没发出那一帧**：
失败的那次 cell 日志里没有任何 `[dsh] runtime ready`——它在 dsh 起来之前就被回收了。

**真因是空闲存活时间记账，三处叠加**（`gateway/spawner.js`）：

1. 新 cell 记录的 `lastTraffic` 记在 **fork 那一刻**（`spawner.js:319`），而冷启动要 8.6–12 秒；
2. 只有 `existing.state === "running"` 分支会刷新它（`:668`）——浏览器冷访问撞上 in-flight
   spawn 时走的是 `if (pending) return pending;`（`:677`），**这条路径完全不刷新**；
3. reaper 唯一看的就是 `lastTraffic`（`~:835`），**挂着的 WebSocket 它看不见**——聊天挂在连接上
   不产生任何 HTTP `ensure()`。

于是"一个正在被使用的 cell"在账上等于"一直空闲"。窗口 6 秒 vs 启动 8–12 秒时，它在 dsh 就绪前
就被 SIGTERM：`ctx.session` 从未建立，而 `sessions` 帧的两个发射点都要求它已存在
（`server/ws.js:422` 的连接时路径、`:349` 的 ready 同步路径），所以那一帧永远发不出来。

**这不只是测试问题**：生产上"用户冷访问 + 短窗口"会把 cell 在其首次对话启动前杀掉；更普遍的
形态是**聊天挂在 WS 上超过窗口就被腰斩**（WS-only 的一轮对话不产生 HTTP 流量）。

**代理诊断还查实一条被 986 秒单跑暴露的放大器**：`if (pending) return pending` 不刷新时钟，
所以冷启动期间所有排队等待者都在给一个不更新的时钟"续命"却续不上——cell 在 boot 完成前被回收，
失败重试又开一个新 spawn，形成**冷启动风暴**。

## What Changes

- `gateway/spawner.js`：新增 `isActive` 钩子（`(cellId) => boolean`，默认 `null` 保持既有行为）；
  reaper 在判定空闲前先问它。`cell.state = "running"` 时把 `lastTraffic` 重置为当下（**空闲时钟
  从"开始服务"起算，不是从 fork 起算**）。`pending` 分支在 spawn 落地后补一次 `lastTraffic` 刷新。
- `gateway/index.js`：网关维护 `liveSockets` 计数表（它才是接受 WebSocket 的一方），以
  `isActive` 交给 registry；upgrade 成功后登记、`close`/`error` 各释放一次（`done` 闩锁防重）。
- `scripts/test-cell-gateway.mjs`：2.4 段那条 **`a cell with an enabled cron job must never be
  reaped` 是过期断言**——`openspec/specs/cell-gateway/spec.md:48-58` 明确写了"enabled cron jobs
  or bots block reaping"这条豁免在 registry 部署下**已被取代**，改由 duty ring 负责唤醒；只有
  无 registry 的 legacy 模式逐字保留。改为断言**工作能活过回收**（cold start 后 cron job 还在），
  而不是断言进程一直开着。

## Capabilities

`cell-gateway` —— 新增一条要求：存活判定必须包含用户仍然挂着的连接，且冷启动的时间不算空闲。

## 非目标

- **不改 demo cell 的回收**：demo 有独立的短窗口，且其数据本来就不保留（`mp-demo-mode`）。
- **不改 duty ring / 驻留策略**：`on_demand` 静默即回收、无 cron 豁免，这是既有裁决，本单只修
  "什么算活跃"，不动"该不该回收"。
- **不动 `idleReapSecs` 默认值**：窗口长度是部署参数，本单修的是记账。

## 验证

- `node --test --test-timeout=180000 scripts/test-cell-gateway.mjs` **连跑 4 次全绿**
  （45s / 42s / 75s / 79s；修复前 3 次里 2–3 次红，且出现 986 秒的冷启动风暴）。
- 相邻 registry/reaper 用例 39/39 绿
  （`test-cell-spawner-dedup` / `test-cell-registry-db` / `test-cell-crash-ledger` /
  `test-cell-wake-admission` / `test-cell-memory-gate`）。
- 诊断阶段的干预性证据：只把 scratch copy 的窗口 6s→20s，304/306/314/315 四条 2/2 变绿——
  证明判别式是"窗口 vs 启动时间"，不是 dsh 安装。
