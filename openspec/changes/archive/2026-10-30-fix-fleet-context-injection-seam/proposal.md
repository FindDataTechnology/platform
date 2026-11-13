## Why

2026-10-30 真机验收 `add-fleet-self-round-context` 时实证逮出：平台重启后恢复执行的舰队任务**拿不到注入的巡视上下文**——补跑轮落库 prompt 仅 283 字符，`{{fleetContext}}` 原样未展开，模型拿裸模板后靠工具自取上下文（该轮多花约 2 分钟）。这与 2026-10-29 修掉的「手动戳发绕过注入」（当时 CEO 轮 prompt 仅 249 字符）是**同一类病的第三条腿**：注入写在散落的 enqueue 侧，而入队路径不止一条。

**四条入队路径，两条在漏**（均已核实）：

| 路径 | 入口 | 走注入？ |
|---|---|---|
| 定时开火 / 补跑开火 | `fireTask` → `applyFleetContext`（cron.js:251） | ✅ |
| 手动立即执行 | `runJobNow` → `applyFleetContext`（10-29 补上） | ✅ |
| **启动恢复持久化 queued 任务** | `drainRepairQueue`（task-engine.js:192）直接 `chainExecution` | ❌ 绕过 |
| **决策送达 execute-now** | `fleets.js:2181` 直接 `setPromptOverride`（只替换决策段，非全量巡视上下文） | ⚠️ 部分注入 |

另有**次序缺陷**：补跑扫描（cron.js:71-77）先把 `【补跑】` 前缀写进 `promptOverride`，随后 `applyFleetContext` 用 `task.prompt.replace(...)` **整体覆盖** promptOverride——前缀被丢；与恢复通道竞态时则反过来（前缀在、上下文丢）。两条路都错，只是错的姿势不同。

## What Changes

- **注入缝唯一化**：把巡视上下文注入从「enqueue 侧散写 promptOverride」移到 **execution 侧唯一汇合点** `runExecutionTurn`（task-engine.js:436）——所有入队路径（定时/补跑/手动/恢复队列/决策送达）最终都经它起轮，缝设在起轮前，一条路径都不漏。
- **引擎新增 `beforeTurn` 异步钩子**（通用机制，不认识舰队）：cron.js 注册注入实现；钩子在 `turnFn` 调用前组合最终 prompt。
- **组合规则**：`final = 补跑前缀(若 t.catchUpPending) + base.replace({{fleetContext}}, 渲染段)`，其中 `base = t.promptOverride ?? t.prompt`。补跑前缀改由 `t.catchUpPending` 标志（既有字段，本就在结算时消费）在缝内组合，**不再预写 promptOverride**——次序缺陷从根上消除。
- **`drainRepairQueue` 无需改动**：恢复通道自然被缝覆盖（这正是选 execution 侧而非 enqueue 侧的理由）。
- **删除 enqueue 侧的注入写手**：`fireTask`/`runJobNow` 里的 `applyFleetContext` 调用移除（cron.js 保留该函数体作为缝的实现）；补跑扫描的 promptOverride 写入移除。
- **显性失败语义保持**：缝内渲染失败/空段 = 该次执行以结构化错误落史（history 记 failed + error），绝不静默按裸模板跑——与既有 spec 口径一致，只是失败点从入队挪到起轮。
- **决策送达路径对齐**：`fleets.js:2181` 的 promptOverride 写法与缝兼容（其 override 已无占位符 → 缝跳过渲染，不双注入）；本变更不改其行为，仅验证无回归。

**非目标**：不改 `{{fleetContext}}` 占位符契约、不改渲染器内容、不碰 `add-fleet-self-round-context` 的注入内容、不改 task-engine 的队列/占槽语义、不处理 `cron_fired` 广播裸模板（既存现状，另行记账）。

## Capabilities

### New Capabilities

（无——本变更收紧既有注入 requirement 的覆盖面，不引入新能力面。）

### Modified Capabilities

- `agent-fleet-report-lane`: 「巡视上下文注入」requirement 收紧为**全部触发路径**（定时、补跑、手动立即执行、**平台重启后恢复执行**、决策送达）必须经同一注入缝获得上下文；补跑标记 SHALL 作为前缀出现在最终 prompt 且不因注入组合而丢失；注入 SHALL 恰好发生一次（不双渲染、不丢前缀）。

## Impact

- **代码**：`task-engine.js`（+`beforeTurn` 钩子，~10 行）、`cron.js`（注入实现注册 + 删两处 enqueue 侧写手 + 补跑扫描简化）、`server/routes/fleets.js`（仅验证，不改）。
- **行为**：每次平台重启后，恢复执行的舰队任务从「裸模板」变为「完整注入」——这正是验收实证的缺陷面。
- **风险**：注入从入队时点挪到起轮时点，渲染发生在执行槽内（渲染为纯函数、毫秒级，可接受）；`promptOverride` 的「per-fire 即弃」语义不变。
- **验收**：真机复现原缺陷路径（触发舰队任务 → 立即滚版 → 恢复执行）→ 断言落库 prompt 含完整注入段与 `【补跑】` 前缀；现有 34 例 report-lane 测试 + cron 链测试全绿。
