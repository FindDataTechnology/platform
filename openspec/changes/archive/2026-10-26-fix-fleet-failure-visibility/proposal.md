# fix-fleet-failure-visibility Proposal

## Why

无人值守舰队当前处于「**跑了但没跑成，界面看不出来**」的状态。fd-wire 2026-10-26 全量普查（7 支活跃舰队、178 条回合）：**132 条失败（74%）**，但绝大多数岗位在控制台仍显示 `正常`。最刺眼的一条是某岗位 `consecutiveFailures=12`、状态仍 `on_duty`——平台自己数了 12 次失败，却不影响状态、不计入异常。

根因：`deriveMemberStatus`（server/fleet-reconcile.js）的判定只看「最近一次执行是否在容忍窗内」（`evidence.lastRunAt`），**不看那一轮是否失败**；状态枚举里也没有「失败」这一档。失败的痕迹散在 `lastTurn` / `consecutiveFailures` / `health.failing` 三处，前端只在一角标里露一个 `×N`，状态色与 `statusCounts` 一律照旧。

对无人值守产品，这比「跑失败并报警」危险得多：用户以为每天在跑，实际什么都没产出；等发现时已经过去很久（既有 `missing` 要等报数也断了才触发）。

本 change 只做这一条（需求稿 §一，P0）。§三（timeout 不可归因）与 §四（上游无熔断/降级）不在此列——它们是独立的设计决策，另案。

## What Changes

- **状态机新增 `failing` 档**：连续失败达到阈值（默认 3，env `PLATFORM_FLEET_FAILING_STREAK` 可调）的岗位，状态由 `on_duty` 降级为 `failing`（需关注）。优先级排在 `missing` 之后——`missing` 是「连信号都没了」，更严重，仍优先。
- **失败证据随状态走**：evidence 增 `failureStreak`（连败数）、`failingSince`（本轮连败起始时刻）、`lastErrorKind`（最近失败类别），让运维一眼看出「为什么降级」并分流（`runtime_not_ready`=平台、`timeout`=预算/工具、`model_upstream`=供应商）。
- **计数与统计对齐**：`statusCounts` 自然纳入 `failing`；`health.failing` 改由状态派生（不再是「最近一回合失败」的独立口径），`normal` 不再包含连败岗位。
- **前端可见**：画布节点、岗位卡、检查器抽屉按 `failing` 着色并给文案（五语言），`×N` 角标保留。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `agent-fleet-core`：在岗与健康状态为派生视图——状态判定的优先级链增一档 `failing`（连续失败达阈值），失败维度进入状态而非仅作旁注；evidence 增连败数与归因字段。

## Impact

- 代码：`server/routes/fleets-db.js`（连败查询带归因）、`server/fleet-reconcile.js`（状态判定）、`server/routes/fleets.js`（memberView 透传 + health 口径）、`web/src/components/fleet/FleetCanvas.tsx` / `InspectorDrawer.tsx` / `web/src/pages/FleetsPage.tsx` + 五语言 locale。
- 语义影响：任何**已有连败**的岗位在下一次读取时立刻变色（读时派生，无迁移）。这是预期效果——那些岗位本来就已经坏了，只是没人看见。
- 不涉及：回合执行路径、重试语义、模型链、调度器（本 change 是纯读面派生 + 状态枚举扩展）。
