# fix-cell-spawn-inflight-dedup — Design

## Context

根因链见 proposal.md（含日志与 `/proc` 证据）。补充两个约束：

- **该文件是热路径**：`ensure()` 在每次用户请求的网关侧入口都可能被调用（HTTP 与 WS 升级两处），修复不能引入额外 await 或阻塞。
- **记录是状态的唯一真相**：`status()`、idle reaper、`/api/gateway/status` 都从 `cells` Map 读；任何"影子登记表"都必须与它保持一致，否则 reaper 会漏算（demo 池上限 `runningDemoCount()` 同样读 `cells`）。
- **既有 exit handler 语义要保住**：`child.on("exit")` 里有 `if (cells.get(userId) !== cell) return;`——它保护"被替换的旧进程退出时不要误删新记录"，这条守卫是**正确**的，缺陷在于替换时没人去 kill 旧进程。

## Goals / Non-Goals

**Goals:**

- 并发 `ensure()` 收敛到一次 spawn。
- 任何时刻每用户至多一个活进程；记录与进程一一对应。
- 修复对 `status()` / reaper / demo 上限的读路径零影响。

**Non-Goals:**

- 不做跨进程/跨副本的分布式去重（网关是单进程，`cells` 是进程内 Map；多副本不在本变更范围）。
- 不改 idle reaper 的调度策略、不改 cell 启动参数矩阵。
- 不重构 spawner 的整体结构（保持函数式风格，最小改动）。

## Decisions

### D1: 用独立的 `Map<userId, Promise>` 做 in-flight 登记，而不是"先占位记录再 spawn"

`ensure()` 顶部：`if (inflight.has(userId)) return inflight.get(userId);` → 未命中则 `const p = spawnCell(user).finally(() => inflight.delete(userId)); inflight.set(userId, p); return p;`。

**替代**（在 `spawnCell` 之前先 `cells.set` 一条 `starting` 占位记录）：会改动 `status()` / reaper / `runningDemoCount()` 对"记录即活进程"的既有假设（它们把 Map 里的条目当成真实 cell 计数），占位记录会让 demo 池上限虚高、status 报出无端口的行。**替代**（把 `cells.set` 提到 `await freePort()` 之前）：能修好守卫时序，但记录里的 `port`/`pid` 尚未知，`status()` 会出现字段为空的中间态；且它只修一半——`spawnCell` 的覆盖语义仍需单独修。

### D2: `spawnCell()` 替换前先终止旧进程

`cells.set(userId, cell)` 之前：若 `cells.get(userId)?.child?.exitCode === null` → `kill("SIGTERM")` 并登记一个升级到 SIGKILL 的定时器（复用 `stop()` 的 5s 宽限语义）。**替代**（拒绝新 spawn、返回旧 cell）被否：旧进程可能已经 wedge（这正是 10-10 事故的形态之一），拒绝会让该用户永久不可用。

### D3: `drop()` 语义保持"只忘记录"，但调用方在替换路径上改为 kill-then-drop

`drop()` 的文档语义是"进程在网关之外死了，忘掉记录"（crash/SIGKILL 场景），保持不动；`gateway/index.js:428` 的 share-respawn 路径在 `registry.drop()` 之前先 `stop()`（或直接用新的 `replace()` 辅助）——由 spec 的"no orphan"场景钉死。

### D4: 单测用可注入的 spawn 函数（既有测试范式）

spawner 已支持 `serverEntry`/`env` 注入；单测用 `CELL_SERVER_ENTRY` 指向一个桩脚本（sleep 若干秒），断言：并发 `ensure()` 两次只产生一个 child、`stop()` 后无活进程、替换路径 kill 旧进程。**替代**（对真实 server.js 跑集成测试）被否：慢且脆；桩脚本能精确控制启动窗口。

## Risks / Trade-offs

- **[inflight 与 cells 双真相]** 两个 Map 可能漂移（如 spawn 抛错时 finally 清理 vs 记录保留）。缓解：`finally` 无条件清 inflight；`cells` 只在 `spawnCell` 内部写；单测覆盖"spawn 失败后 inflight 已清、可重试"。
- **[SIGTERM 宽限期的进程仍在写库]** 替换瞬间旧进程可能仍在写 SQLite。缓解：宽限期与 `stop()` 一致（5s→SIGKILL）；且替换发生在同一用户的请求路径上，旧进程已无流量（无新回合），写窗口极短。这与 rebuild 的"停 cell 再写"是不同层级：rebuild 要求完全静止，替换只要求"不再有新写"。
- **[孤儿已存在于生产]** 修复只防新孤儿，不清理既有的。缓解：生产处置任务显式 kill 现存孤儿（pid 86793），并验证每用户单进程。

## Migration Plan

1. 本地单测（并发去重、替换 kill、drop 后 ensure 单进程）。
2. 镜像滚动 fd-prod（网关重启 → 所有 cell 按需重生；注意 10-07 的 `compute-quota` 满坑：滚动前确认配额余量）。
3. 生产处置：kill 孤儿进程 → 确认 `2b043ce050ca134c` 与 `1da519d4c1c0bf89` 各只有一个 cell 进程 → 记录到 change 报告。
4. 回滚：单文件改动，回滚镜像即可（无数据迁移）。

## Open Questions

（无。）
