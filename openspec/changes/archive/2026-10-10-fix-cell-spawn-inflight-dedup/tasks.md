# Tasks: fix-cell-spawn-inflight-dedup

## 1. 修复 spawner

- [x] 1.1 `gateway/spawner.js`：新增模块级 `inflight = new Map()`；`ensure()` 顶部查 inflight（命中即返回同一 promise），`spawnCell(user).finally(() => inflight.delete(userId))` 后登记——单测：桩 cell 启动窗口内并发 `ensure()` 两次，断言只 spawn 一个 child、两个 promise 解析到同一 cell
- [x] 1.2 `spawnCell()` 替换语义：`cells.set(userId, cell)` 前若既有记录的 child 仍存活（`exitCode === null`）先 `kill("SIGTERM")` + 5s 升级 SIGKILL 定时器——单测：先起一个桩 cell，再 spawn 同用户，断言旧 child 收到 SIGTERM 且最多一个活进程
- [x] 1.3 `gateway/index.js` share-respawn 路径（`:428` 附近）：`registry.drop()` 之前先停旧进程（用 `stop()` 或等价辅助），保证"drop 后无活进程"——单测或桩脚本断言 drop 路径不留孤儿
- [x] 1.4 失败路径：`spawnCell` 抛错时 inflight 已清、可重试；`cells` 不被写入半成品记录——单测：桩入口不存在 → ensure 拒绝 → 再次 ensure 能重试成功

## 2. 回归

- [x] 2.1 既有 gateway 单测全绿（`node --test scripts/test-gateway-*.mjs`）——含 sessionless / bot-webhooks 等既有覆盖
- [x] 2.2 `status()` / idle reaper / demo 池上限读路径零回归：断言修复后 `cells` 语义不变（记录即活进程）——单测：起两个 cell 断言 `status().length === 2`、demo 计数正确

## 3. 生产处置与验证（fd-prod / cheap-3）

- [x] 3.1 滚动前确认 fd-prod `compute-quota` 余量（10-07 满配额坑）——`kubectl -n fd-prod describe quota` 有 ≥2Gi 余量
- [x] 3.2 镜像滚动上线；网关日志无异常；各 cell 按需重生——`/api/gateway/status` 行数合理、无 error 记录
- [x] 3.3 清理现存孤儿：kill 宿主 pid 86793（`2b043ce050ca134c` 的孤儿 cell），确认该用户与 `1da519d4c1c0bf89` 各只剩一个 cell 进程——`ps` + `/proc/<pid>/fd` 核对，记录到 change 报告
- [x] 3.4 复现性验证：对目标 cell 制造一次并发首访（同时发两个请求）→ 断言只产生一个进程（日志只有一条 `running on`）——证据入报告
- [x] 3.5 归档前 `openspec validate fix-cell-spawn-inflight-dedup --strict` 全绿
