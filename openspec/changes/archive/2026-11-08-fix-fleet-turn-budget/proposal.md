# fix-fleet-turn-budget Proposal

## Why

两个**已经在规格里承诺生效**的预算旋钮，在 persona/a2a 回合上从来没有生效过——不是"没做"，是**声明被
一个常量覆盖**。`task-engine.js:683` 给每一次回合都塞同一个数：

```js
const result = await turnFn(effective, { turnTimeoutMs: TURN_TIMEOUT_MS });  // 10 * 60 * 1000
```

而下游 `server/cron-runner.js:1284` 是 `const timeoutMs = turnTimeoutMs || resolveTurnBudgetMs(job);`
——`||` 左边永远非空，所以 `resolveTurnBudgetMs`（`cron-runner.js:114`，带 2min/30min 夹紧、
六条单测在 `scripts/test-fleet-turn-budget.mjs`）**一次都没被调用过**。

后果按旋钮分两条：

1. **`cadence.turnTimeoutMs`（按岗位声明）空转。** `cron-module` 规格
   `Requirement: 舰队成员回合预算可按岗位声明` 明写"界内值 SHALL 生效"，并有一条场景：
   提案岗声明 1200000（20 分钟）、推进到第 12 分钟仍应继续。生产实证相反：该岗位被
   **621s 杀掉并落 `turn_budget_exceeded`**（2026-11-07 记在案）。规格写的场景，实现从没兑现。
2. **`constraints.budgetPerEdgeMin`（按边声明）只在 cluster 分支生效。** 编排层把它铸成
   `executionPolicy.timeoutMinutes` 打在 dispatch/handoff/fanout 任务上（`fleet-handoffs.js:93,108,163`），
   `agent-fleet-orchestration` 规格要求"每跳时长上限取 budgetPerEdgeMin"；但只有
   `runClusterTurn` 读它（`cron-runner.js:1021-1025`），persona/a2a 跳一律吃 600s。
   它在 `turn-request.js:90` 还留了个 `budget` 字段——**描述性字段，没有任何执行面读它**，
   等于把"有这个预算"写进了请求，然后不执行。

3. **为什么五条单测没拦住。** `scripts/test-fleet-turn-budget.mjs` 的文件头写着
   "member cadence.turnTimeoutMs within [2min, 30min] takes effect"，但五条断言全部只调
   `resolveTurnBudgetMs()`——**测的是解析器，不是"这个数到了回合上"**。解析器本身没毛病，
   缺陷在它上游那一行 `||`。这正是「验证要对着坏的那个本身」的反例。

Why now：多智能体协同审计把它列为切片①（"第 0 层 修谎：把声明了但没兑现的旋钮变成事实"），
且它是 A2A 超时修复（`fix-a2a-call-timeout`，已上产）的配套——委托回合的远端调用上界现在真的
取自"回合预算"，而那个预算目前恒为 600s，所以整条时间线还是钉死的。

## What Changes

- **引擎不再自造预算**：`initTaskEngine({ resolveTurnBudget })` 新增解析器注入；有解析器时
  `turnFn(task, { turnTimeoutMs: resolveTurnBudget(task) })`，没有时退回既有 600s 常量
  （任何未接线的调用方行为逐字节不变）。**绝不再把常量当预算**。
- **解析顺序落成一条规则**（此前规格未定，属真空）：任务自带的边预算
  `executionPolicy.timeoutMinutes`（按边，最具体）→ 岗位 `cadence.turnTimeoutMs`（按岗）→
  默认 10 分钟；两个声明值都夹紧到 [2min, 30min]，非法值跳过下一条而不是直接崩。
- **`cron.js` 接线**：把 `resolveTurnBudgetMs` 注册为解析器，让引擎与 runner 用同一个解析器
  （一处判据，避免两边各算一套）。
- **补真断言测试**：①引擎把解析器的数原样交给 `turnFn`；②无解析器时仍是 600s；
  ③边预算优先于岗位预算；④越界夹紧；⑤**反向证明**——把 `task-engine.js:683` 的注入去掉，
  ①②之外的"预算到达回合"断言必须红。

非破坏性：未声明任何预算的岗位/任务仍走 600s，行为与变更前一致；不改 A2A、不改重试策略、
不改凭据交付硬顶（其"不小于最长单回合预算"口径自动跟随本变更后的最坏值 30min）。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `cron-module`：把"解析出的预算就是回合实际执行的上界"与"边预算 > 岗位预算 > 默认"的优先级
  写成需求（现有需求只说了岗位字段生效，没说两者并存时谁说话，也没说引擎不得用常量替代）。

## Impact

- 代码：`task-engine.js`（解析器注入 + 调用点）、`server/cron-runner.js`
  （`resolveTurnBudgetMs` 增边预算与优先级）、`cron.js`（注册解析器）。
- 测试：`scripts/test-fleet-turn-budget.mjs`（扩为"解析器 + 交付"两层）、
  `scripts/test-task-engine.mjs`（引擎侧注入/回退），新增或扩充共约 8 条。
- 行为变化仅限**声明过预算**的舰队回合：这些回合的上界从恒 600s 变成声明值（2–30 分钟）。
  未声明者不变。**风险面**：声明大预算的岗位会把串行回合槽占更久，这是声明的本意；
  上界仍被 30 分钟夹死。
- 关联：`docs/multi-agent-collaboration-explore.md` §八 切片①、§五 P0-1；
  配套 `fix-a2a-call-timeout`（已归档上产）。
