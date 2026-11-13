# Proposal — fix-turn-contract-admission

## Why

`assertTurnRequest`（`server/turn-request.js:103`）是 turn 契约的**结构门**：保留源 `peer`、保留槽
`blackboard`、以及按道分界的深度上限。它有 13 条测试，**生产里零调用**（explore P2-7 第三项）——
一盏装了却没人接的绿灯。

深度上限目前只在**链位被创建的地方**执行：dispatch 恒钉 1（`routes/fleets.js:1200`），
handoff / fanout 在点火时比对声明（`fleet-handoffs.js:201,310`）。于是留下一个真洞：

> **声明可以在链位入队之后收紧。** 一个 depth=4 的接棒回合排队期间，舰队把 `maxChainDepth`
> 改成 2 —— 这个回合起轮时早已超过当前声明，而没有任何一层会拒绝它，链式放大照跑。

## What Changes

- `fleet-runs.js` 的回合账本增加 `admission(job)`：用**当前**舰队声明 `constraintsOf(fleet.orchestration).maxChainDepth`
  校验派生出的 turnRequest（复用 `assertTurnRequest`）。非舰队任务返回 `null`（**null 是「不判」不是「拒绝」**，
  调用方不得混淆）；舰队已删同样返回 null（既有跳过路径负责）。
- `cron-runner.js` 在本轮起轮前、账本开启前调用它；拒绝时本轮以
  `{ ok:false, error: "turn contract refused: …" }` 收口，并照既有形状落一条回合事件
  （与「运行时就绪门」同一位置、同一形态），**不静默丢行**。
- 未挂账本的挂载（旧挂载/测试）保持零扰动（degrade open）。

## Impact

- Affected specs: `agent-turn-contract`（MODIFIED：契约取值受界 —— 追加执行侧再校验与 2 个场景）
- Affected code: `server/fleet-runs.js`（`admission`）、`server/cron-runner.js`（起轮前门）
- 无迁移、无新表、无新 env；合法回合的行为逐字节不变（校验通过 = null，不改变结果）。
- 顺带按代码证据改正路线图：P2-6 的「无取消 run」**后端已实现**（`stopRun` + 路由），缺的是 UI 入口。
