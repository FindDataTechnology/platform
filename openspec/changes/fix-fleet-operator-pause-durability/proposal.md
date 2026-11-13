## Why

2026-11-10 生产实测：主人用 `POST /api/cron/:id/pause` 停掉一个**舰队成员**的节奏任务后，暂停在**没有任何人恢复**的情况下被撤销了。

- 21:07Z 前后暂停 `job_1794128300056_hwmvbw`（`sourceTag` 指向 `fleet_1794098779663_gnofzb/m_1794098779663_wah44o`），写入盘内 `paused=true, status=paused`。
- 22:22Z 读盘：`paused=false, status=scheduled`。同一时刻日志有 `[catalog] cloud cache seeded (3 agent(s))`（一次**成功**的目录变更）。
- 代码对位：`server/fleet-reconcile.js:196` 每轮重算 `desiredPaused = fleet.state !== "active" || member.cadence.enabled === false || !target.alive`，第 213–215 行对「不该暂停却被暂停」的任务**主动 `resumeJob`**；触发链是 `server.js:1687` catalog `onChange` → `reconcileAllFleets`。
- 排除项：`paused` 在 `saveTasks` 持久化白名单里（`task-engine.js:242`）、`loadTasks` 原样保留，`/data` 是 hostPath（非临时盘）；暂停后按 30s 间隔观测 150s，其中一次整表重写（13:37:05）**保留了** `paused=true`——说明不是周期写者覆盖，而是上述 reconcile 路径。

后果：任何「停掉一个跑不好的岗位」的操作都是**假的**——下一次目录变更（catalog 刷新是常态，不依赖人操作）就把它开回来，而界面上看不出发生过什么。

## What Changes

- 任务记录新增 `pausedBy` 字段（`"operator"` | `"fleet"` | null），区分**两类暂停层**：主人从队列侧暂停 vs 舰队收敛按 `desiredPaused` 暂停。
- `cron.pauseJob` 由 API 路由调用时写 `pausedBy="operator"`；`reconcileFleet` 自己暂停时写 `pausedBy="fleet"`。
- `reconcileFleet` 的 resume 分支加一条前置：`existing.pausedBy === "operator"` 时**不自动恢复**，只在响应里记 `out.respectedPause`；主人显式 `resumeJob` 会清空 `pausedBy`，之后收敛重新接管。
- 幂等/兼容：无 `pausedBy` 的历史记录按 `"fleet"` 处理（保持既有行为，避免升级瞬间把一批人工暂停当成不可恢复）。

## Impact

- 影响代码：`paas/cron.js`（pause/resume 写标记）、`paas/server/fleet-reconcile.js`（resume 前置判定 + 回执字段）、`paas/task-engine.js`（`pausedBy` 进持久化白名单）。
- 影响面：全部舰队成员任务的暂停语义；非成员任务不受影响（收敛只管带 `sourceTag` 的节奏任务）。
- 风险：若把历史记录默认当成 `"operator"`，会让一批本该被收敛恢复的岗位永久停住——所以默认值必须是 `"fleet"`。
- 验收口径：暂停一个成员任务 → 触发一次成功的目录变更（或直接跑 `reconcileAllFleets`）→ 任务仍 `paused=true`；且 `out.respectedPause` 含该任务 id。
