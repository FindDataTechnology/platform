# Design — fix-fleet-turn-budget

## Context

预算有两个声明面、三个消费点，而现在线上只有一个数（600s）：

```
声明面                             消费点
─────────────────────────────────  ────────────────────────────────────────────
member.cadence.turnTimeoutMs       resolveTurnBudgetMs(job)  ← 一次都没被调用
fleet.constraints.budgetPerEdgeMin
  → job.executionPolicy.timeoutMinutes   runClusterTurn(...)  ← 只有 cluster 分支读
                                          turn-request.js:90  ← 只写进描述字段，无人执行
```

`task-engine.js:683` 是中间那层：它把 `TURN_TIMEOUT_MS` 交给 `turnFn`，而 `turnFn` 是
`ctx.runCronJobTurn`（`cron-runner.js:1283`），后者的 `turnTimeoutMs || resolveTurnBudgetMs(job)`
因此永远走左边。worker 池那条路（`worker-slots.js:173` → `runOnWorker(worker, task, opts)`）拿的是
同一个 `opts`，最终进 `collectTurn(..., timeoutMs, ...)` → `setTimeout(..., timeoutMs)`。

**关键约束**：`collectTurn` 里是 `setTimeout(cb, timeoutMs)`。`timeoutMs` 若是 `undefined`，
Node 视为 0 → 回合**立刻**超时。所以"引擎干脆不传"这种改法会秒炸全场。上界必须**永远是一个正的有限数**。

## Goals / Non-Goals

**Goals**

1. 岗位声明的 `turnTimeoutMs`、边声明的 `budgetPerEdgeMin` 都在 persona/a2a 回合上真实生效。
2. 两者并存时优先级唯一且写进规格：**边 > 岗 > 默认**。
3. 任何接线未到位的情况下，行为与今天逐字节一致（默认 600s）。
4. 测试对准"解析出的数到达回合"，不是只测解析器。

**Non-Goals**

- 不改预算的**界**（仍 [2min, 30min]）——抬界是产品决策，另立。
- 不改 `collectTurn` 的超时错误文案/分类（`turn_budget_exceeded` 已有）。
- 不给 cluster 分支换解析器（它已读 `policy.timeoutMinutes`，与新的优先级一致；改动只增加风险）。
- 不改 `turn-request.js` 的 `budget` 描述字段（它是给上游/审计看的事实，不是执行面）。

## Decisions

### D1 · 引擎从"造数者"变成"要数者"：注入解析器，回退常量

```js
// task-engine.js
let resolveTurnBudgetFn = typeof resolveTurnBudget === "function" ? resolveTurnBudget : null;

// :683 调用点
const budget = resolveTurnBudgetFn ? safeBudget(resolveTurnBudgetFn(effective)) : TURN_TIMEOUT_MS;
const result = await turnFn(effective, { turnTimeoutMs: budget });
```

`safeBudget(v)`：`Number.isFinite(v) && v > 0 ? v : TURN_TIMEOUT_MS`。解析器抛错也走 `catch` → 默认
（`cron-module` 规格既有条款"预算解析失败 SHALL 降级为默认值"）。

- **为什么不把解析放进 `turnFn` 里**：`turnFn` 有两个实现（`runCronJobTurn`、worker 的
  `runOnWorker`），而且 worker 那条根本不经 `resolveTurnBudgetMs`。把解析上提到引擎，两条路一次修好。
- **为什么保留常量**：`initTaskEngine` 是通用引擎，测试与其它宿主可能不传解析器；
  "不传 = 今天的行为"是这次改动的安全边界，也让反向证明可写（去掉注入 → 断言红）。

### D2 · 优先级：边 > 岗 > 默认，且两个声明都夹紧

`resolveTurnBudgetMs(job, {db})` 扩成：

```js
const edgeMs = Number(job?.executionPolicy?.timeoutMinutes) * 60_000;   // 边
const declared = edgeMs > 0 ? edgeMs : member?.cadence?.turnTimeoutMs; // 岗
if (!ok(declared)) return DEFAULT;                                     // 默认
return clamp(declared, FLOOR, CEILING);                                // 2–30min
```

- **为什么边优先**：边预算是舰队所有者对这个**跳**的显式声明（编排层逐跳铸进任务），岗位预算是岗位
  自己的默认。更具体者胜出。
- **为什么不"取小"**：取小会让放宽失效（所有者调大边预算永远无效）。显式优先级的可解释性 > 保守。
- **为什么 edge 也要夹**：`budgetPerEdgeMin` 来自用户输入（`fleet-orchestration` 只做 num 归一），
  不夹的话 9999 分钟会绕过所有界。

### D3 · 一处判据：`cron.js` 注册，runner 复用同一个函数

`cron.js` 的 `initTaskEngine({...})` 增 `resolveTurnBudget: (task) => resolveTurnBudgetMs(task)`
（import 自 `cron-runner.js`）。runner 内部第 1284 行的 `turnTimeoutMs || resolveTurnBudgetMs(job)`
**保留不改**：引擎现在传下来的已经是解析结果，非空，语义仍一致；万一有别的宿主直接调
`runCronJobTurn(job)` 而没给 `turnTimeoutMs`，这行仍然是正确的兜底。

## Risks / Trade-offs

- **R1 · 声明大预算的岗位占槽更久**：声明的本意，且界仍 30 分钟。取舍：串行槽的占用是 owner 用
  `turnTimeoutMs` 自己换来的，平台不该二次否决。
- **R2 · 边默认值 10 分钟与旧常量同值**：所以"什么都没声明"的舰队行为不变——这是本次最想保的不变量，
  用 `test-fleet-turn-budget` 的"未声明"用例钉住。
- **R3 · 历史报表口径**：原先 `turn_budget_exceeded` 全在 600s 附近；修后声明岗位的失败点会移到其
  声明值附近。观测口径要跟着改（在 tasks 里记一条观察项）。
- **R4 · 与 A2A 超时的叠加**：`fix-a2a-call-timeout` 让委托远端调用以"回合预算"为上界；预算变大后
  远端调用上界同步变大——方向正确（一条时间线），但单个远端卡死最多拖 30 分钟。可接受，且
  A2A 侧已有可归因超时。

## Migration Plan

无 schema、无配置、无协议变更；一次滚版生效。回滚 = revert（唯一行为差异是声明过预算的回合的失败点位置）。

## Open Questions

无阻塞。观察项：上线后按岗位统计 `turn_budget_exceeded` 的发生时长分布，确认与声明值对齐（tasks 里记）。
