# Proposal: fix-cell-spawn-inflight-dedup

## Why

2026-10-10 在 cheap-3 上实测到一个 cell 生命周期缺陷：**同一用户被 spawn 了两个 cell 进程，且两个进程同时持有并写入同一个 SQLite 索引库**。

证据链（pod 日志 + `ps`）：`2b043ce050ca134c` 在 09:43:04 与 09:43:09 两秒内被 spawn 两次（pid 88 与 97，端口 43315 / 43097），中间无任何 stop/drop；15:56 的 idle 回收只杀了记录里的 pid 97，pid 88 成为**孤儿**（ppid 仍是网关、持有 DB 句柄与 dsh 子进程、无人回收）；16:45 用户流量到达时又正常 spawn 了 pid 279。当前宿主上 pid 86793（孤儿）与 216521 并存，两个进程的 `/proc/<pid>/fd` 指向同一批 `app.db`/`app.db-wal` 文件。

根因在 `gateway/spawner.js` 的 `ensure()`：去重守卫 `if (existing?.starting) return existing.starting` 依赖 `cells.get(userId).starting`，但 `starting` promise 是在 `spawnCell(user)` **返回之后**才挂上的（`const cell = cells.get(userId); if (cell) cell.starting = started;`），而 `cells.set(userId, cell)` 发生在 `spawnCell()` 内部、位于 `await freePort()` 与三个 `await mkdir()` **之后**。因此在 cell 启动窗口内到达的第二个请求读到的 `cells.get(userId)` 是 undefined → 守卫失效 → 再 spawn 一个。`spawnCell()` 的 `cells.set` 又是无条件覆盖，不 kill 旧 child；被覆盖的进程随后成为孤儿（其 exit handler 有 `if (cells.get(userId) !== cell) return;` 守卫，退出时也不清理）。

这是**数据安全**问题，不只是资源浪费：两个 server 进程并发写同一 WAL 库是损坏风险，而 2026-10-10 的会话索引重建必须先消除这个风险源。同类隐患还有 `registry.drop()`（只删记录不杀进程，见 `gateway/index.js:428` 的 share respawn 路径）。

## What Changes

- **修 `ensure()` 的 in-flight 去重**：把"正在启动"这个状态做成**先占位、后 spawn**——在调用 `spawnCell()` 之前就建立去重记录（或使用独立的 `Map<userId, Promise>` 作为 inflight 登记），使并发 `ensure()` 命中同一条 promise，而不是各自 spawn。
- **修 `spawnCell()` 的覆盖语义**：`cells.set(userId, cell)` 前先检查既有记录；若存在仍存活的 child，先终止它（或拒绝这次 spawn），确保**一个用户同时至多一个 cell 进程**。
- **修孤儿不可回收**：`stop()`/`drop()` 在"记录被替换但进程仍活着"的情况下也要能终止真实进程（记录里保留可 kill 的 child 句柄，或在替换时同步 kill）。
- **契约化**：`cell-gateway` spec 增补"并发 ensure 只启动一个 cell"与"一个用户至多一个 cell 进程"要求。
- **生产处置**：滚动上线后杀死现存孤儿进程（pid 86793），确认每用户单进程。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `cell-gateway`: "Cells start on demand and are always-on by default" 增补并发启动去重与"每用户至多一个 cell 进程"的 SHALL 语言与场景。

## Impact

- **改动**：`gateway/spawner.js`（`ensure` / `spawnCell` / `stop` / `drop` 的进程唯一性保证）、相应单测。
- **不改**：cell 的启动参数矩阵、网关路由、`/api/gateway/status` 形状、idle reaper 的调度语义（仍按 `lastTraffic`）。
- **生产**：fd-prod 网关滚动更新（会重启网关 → 所有 cell 按需重生，秒级抖动）；随后清理现存孤儿进程。
- **前置关系**：本变更是 `rebuild-chat-index` 生产执行的前置（否则新库会被孤儿进程并发写）。
