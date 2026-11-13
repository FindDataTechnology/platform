# Proposal — add-fleet-run-budget

## Why

每条边都有 `budgetPerEdgeMin`（默认 10 分钟），但**没有任何东西管整条链**：

- 一个 8 跳的 pipeline，每跳都合规，整条 run 可以跑 80 分钟、烧掉任意多的 token；
- 扇出 × 每跳扇出会指数放大，深度界只在**深度**上拦，不在**总量**上拦；
- 出了问题**没有刹车**：只能等每一跳各自超时。

explore P2-6 / §4.6 记的就是这条：「无整链/整 run 花费闸；无取消 run 的入口；
`spanMax` 只 warn」（证据 `fleet-orchestration.js:228`）。

## What Changes

- **声明**：`orchestration.constraints.runBudget = { maxTurns?, maxTokens?, maxMinutes? }`，
  三个维度独立可选，**未声明 = 无上限**（既有舰队行为逐字节不变）。
- **执行点在边点火**：起火前读 run 头行 + 该 run 的回合事实（终态从回合行取，另加仍在
  排队/执行的任务），任一维度达上限 → 不建任何下游任务、把上限写成该 run 的**停车原因**、
  并落一条「点火被拒」事实行（不静默）。
- **停车入口**：`POST /api/fleets/:id/runs/:runId/cancel`（owner）——记停车时刻与原因、
  中止该 run 在飞回合（复用既有 `taskTurnRegistry` 中止注册表，落 `interrupted` 而非
  `failed`）、并使该 run 后续点火全被拒。**幂等**：保留首次原因，不重复中止。
- **不做**：不改 `spanMax`（维持 advisory）；不做「预算将尽预警」；不做按 USD 的预算
  （价格表只在日汇总行，按 run 计价需要新缝，另立）。

## Impact

- Affected specs: `agent-fleet-orchestration`（1 个新增 requirement）
- Affected code: `server/fleet-orchestration.js`（声明与校验）、`server/routes/fleets-db.js`
  （`stopped_at`/`stop_reason` 两列、`stopRun`、`runUsage`）、`server/fleet-runs.js`
  （账本 `stopRun`，含按 run 中止在飞会话）、`server/fleet-handoffs.js`（点火闸）、
  `server/routes/fleets.js`（cancel 路由 + 读面带停车事实）
- 迁移：`fleet_runs` 加两列，走既有 `try { ALTER TABLE } catch {}` 幂等模式；老库无需
  数据回填，老 run 读作「未停车」。
