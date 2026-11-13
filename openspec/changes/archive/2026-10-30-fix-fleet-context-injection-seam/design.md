## Context

动机与四条路径的实证见 `proposal.md - Why`。已核代码事实：

- **唯一汇合点**：所有入队路径最终都进 `runExecutionTurn`（task-engine.js:436-458）——`effective = t.promptOverride ?? t.prompt`（:450），随后 `turnFn(effective)`。缝设在 `effective` 组装处，覆盖面是全量的。
- **恢复通道**：`drainRepairQueue`（task-engine.js:192-204）把持久化 `queued` 的 id 直接 `chainExecution`，绕过 enqueue 侧一切逻辑——这是实证缺陷的载体。
- **次序缺陷**：补跑扫描（cron.js:69-79）`setPromptOverride(id, 【补跑】+base)` 后调 `void fireTask(id)`；`applyFleetContext`（cron.js:236-241）用 `task.prompt.replace(...)` 整体覆盖 promptOverride。正常补跑丢前缀；与恢复通道竞态时执行先读走了「前缀+裸模板」。
- **第四个写手**：决策送达（server/routes/fleets.js:2181-2183）把占位符替换为**仅决策段**写入 promptOverride——与缝共存的前提是其覆写不含占位符。
- **`catchUpPending` 已是任务记录字段**（cron.js:71 置位、task-engine.js:498-499 结算即清）——前缀组合的数据载体现成，无需新字段。
- 渲染器 `buildFleetContext` 为纯函数（deps 全注入），毫秒级；在执行槽内调用无阻塞风险。

## Goals / Non-Goals

**Goals:**
- 任一路径起轮的舰队任务 prompt 都已注入（恢复通道不再漏）。
- 补跑前缀与注入段共存且不互覆盖。
- 注入逻辑只存在一处（缝内），删散写。

**Non-Goals:**
- 不改渲染内容（`add-fleet-self-round-context` 的范围）。
- 不改队列/占槽/重试语义。
- 不修 `cron_fired` 广播裸模板（:443 广播的是 `t.prompt` 模板而非 effective——既存现状，另行记账）。
- 不动决策送达的行为（仅验证兼容）。

## Decisions

### D1 缝设在 execution 侧（runExecutionTurn 内），不设在 enqueue 侧

enqueue 侧有四条路径且还会增加（历史上已漏两次：手动、恢复）；execution 侧只有一个汇合点且天然覆盖未来路径。代价是渲染移入执行槽（毫秒级，可接受）。

> 备选（给 `drainRepairQueue` 单独补注入）：否——治标，第五条路径出现时再漏一次；且「补跑前缀丢失」的次序缺陷它治不了。

### D2 引擎加通用 `beforeTurn` 异步钩子，cron.js 注册实现

`initTaskEngine` 增 `beforeTurn` 参数（与既有 `onFinished` 同型）；`runExecutionTurn` 在组装 `effective` 前等待 `beforeTurnFn(t)`，钩子返回 void、通过直接写 `t.promptOverride` 交付最终 prompt（沿用 per-fire 即弃语义，`finishExecution` 的清点逻辑不变）。引擎不认识「舰队」，只认钩子——分层不破坏。

> 备选（把 prompt 组合逻辑整个搬进 task-engine）：否——引擎要保持调度通用，舰队知识（占位符、渲染器、补跑文案）留在 cron 层。

### D3 组合规则：前缀取自 `catchUpPending`，占位符替换基于 `promptOverride ?? prompt`

```
base   = t.promptOverride ?? t.prompt
prefix = t.catchUpPending ? 【补跑】文案 : ""
if (fleet 任务 && base 含 {{fleetContext}}) base = base.replace(占位符, 渲染段)
t.promptOverride = prefix + base   // 缝的交付
```

- 补跑扫描只置 `catchUpPending = true` + 入队，**不再预写 promptOverride** → 次序缺陷根除。
- 决策送达的覆写不含占位符 → 缝跳过渲染，单份内容，无双重注入（spec 场景钉死）。
- 渲染失败/空段 → 抛结构化错误 → `runExecutionTurn` 的 catch 落 `finishExecution(ok:false)` → history 记 failed + error，与「显性失败」口径一致。

### D4 enqueue 侧写手全删，`applyFleetContext` 函数体保留改作缝的实现

`fireTask` 退化为「校验 + enqueueExecution」；`runJobNow` 不再调 applyFleetContext（10-29 的补丁被缝取代）；补跑扫描删 promptOverride 写入。`applyFleetContext` 移为 `beforeTurn` 的实现体（签名改为吃 task record）。

> 保留 enqueue 时点校验（不渲染，只查占位符在不在）可以更早报错，但会把「渲染失败」与「无占位符」两种静默面留在两处——不值，全删。

### D5 测试以「路径 × 断言」矩阵组织

四条路径各一例：定时（既有）、手动（既有 10-29 用例改缝后口径）、**恢复队列（新增——jobs.json 预置 queued 态 → initTaskEngine → drainRepairQueue → 断言起轮 prompt 已注入）**、补跑共存（新增——置 catchUpPending → 断言前缀 + 注入段同在）。决策送达兼容一例（既有用例保绿）。

## Risks / Trade-offs

- **[渲染进执行槽]** 慢渲染会占住串行链 → 渲染为纯函数毫秒级；若未来渲染器变慢，可回填「enqueue 时预渲染 + 缝内只取缓存」，接口不变。
- **[beforeTurn 异常]** 钩子抛错不能炸引擎 → 缝内 try/catch 转 `finishExecution(ok:false)`，引擎主流程不感知。
- **[决策送达回归]** 该路径 override 与缝的组合次序 → D3 规则覆盖 + 既有用例保绿；真机走查决策送达一次。
- **[双版本窗口]** 滚版窗口内新旧代码对 queued 任务的处置不同 → 恢复通道本就每重启触发一次，缝上线后的第一次重启即完成自愈。

## Migration Plan

1. 纯平台侧，无迁移。
2. 上线即覆盖下一次重启/补跑；无需数据回填。
3. 回滚：还原 `task-engine.js`/`cron.js` 两个文件即可（钩子无持久化痕迹）。

## Open Questions

- `cron_fired` 广播裸模板（task-engine.js:443）是否顺手改为广播 effective prompt：与队列语义无关但涉及前端展示口径，**不进本变更**，另行记账。
