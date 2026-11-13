# Proposal — add-cockpit-run-stop

## Why

取消 run 的**后端早就有了**：`fleet-runs.stopRun` 会把 run 头打上停止标记，并通过
`taskTurnRegistry` 中断在飞回合（`add-fleet-run-budget` D3），路由 `POST /api/fleets/:id/runs/:runId/cancel`
也在（`routes/fleets.js:950`）。但驾驶舱**没有任何入口**——`RunTimeline` 只读不写，
全仓 `web/src` 里搜不到对这条接口的调用。

结果就是：一轮跑飞的波（它自己还在点火接棒/扇出）想停，只能进 SQL 或 curl。这不是缺能力，
是**能力没接到人手上**——explore P2-6 的「无取消 run」在 UI 这一层的真实形态。

## What Changes

- `web/src/api/fleets-api.ts` 新增 `cancelRun(fleetId, runId, reason?)`：POST 既有取消接口，
  返回 `{ cancelled, alreadyStopped, abortedTurns, run }`；错误体里的 `error` 原样带出（不吞）。
- `RunTimeline` 的 run 详情头部：
  - **仅在** `status === "open"` 且 `stoppedAt == null` 时呈现「停止这一轮」按钮；
  - 点击先开**危险态确认框**（复用 `ui/confirm-dialog`，取消在 DOM 前、Esc = 取消），文案说明
    「在飞回合会被中断、已完成回合与报数保留、停止后不再点火新的接棒/扇出」；
  - 确认后调一次接口，然后**如实回执**三种结果之一：已停止（含中断回合数）/ 此前已停止 / 失败原因；
  - 停止后头部改呈现**停止标记 + 停止原因**，按钮消失。
- 停止标记走 `ui/status-pill` 的 `paused` 语义色（不自绘颜色，`design-lint` 零新增违规）。
- 5 个语种全部补齐文案（zh-CN 主导，`check:locales` 通过）。

## Impact

- Affected specs: `agent-fleet-cockpit`（MODIFIED：执行实例时间线与画布回放 —— 追加停止操作与 3 个场景）
- Affected code: `web/src/api/fleets-api.ts`（新增 `cancelRun` + `RunListEntry.stoppedAt/stopReason/cost` 类型）、
  `web/src/components/fleet/RunTimeline.tsx`、5 个 locale 文件、`e2e/fleets.spec.js`（新增 1 条 e2e）
- 后端零改动（接口与中断语义都是现成的）；无迁移、无新 env。
