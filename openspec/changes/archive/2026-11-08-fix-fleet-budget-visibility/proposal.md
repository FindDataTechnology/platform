# Proposal — fix-fleet-budget-visibility

## Why

2026-11-08 产线实测：一天内 **441 个回合**因
`budget_exhausted: all candidate models over daily/monthly budget` 失败，集中在两个 cell（350 / 91），
**没有任何一处告诉主人「额度用尽了」**。

根因是归因粒度不够，不是没有失败面：

```js
// server/fleet-events.js —— 旧分类表，budget 被 model_upstream 吃掉
["model_upstream", /no runnable model|model switch|…|upstream|…|模型/i],
```

那句错误文本里含 `model`，于是被归成「上游抖动」。读面上：
- 岗位卡的连败归因写 `last: model_upstream`（主人会去查 provider，实际是额度）；
- 舰队健康聚合只有计数桶，没有「多个岗位同时因同一原因失败」这一层；
- 结果：批量失败静默进行，直到有人手工翻库。

## What Changes

- **归因**：`ERROR_KINDS` 增 `budget`，匹配规则**排在 `model_upstream` 之前**（否则仍被吞）。
  中英双语都覆盖（`budget_exhausted` / `over the daily budget` / `额度用尽` / `额度打满` / `预算超限`）。
- **舰队聚合**：`fleets-db.budgetPressure(fleetId, { windowMs })` 只读一次查询，返回
  `{ members, failures, since, windowHours }`；无此类失败返回 `null`（不是零值）。
  挂在 cockpit 的 `health.budgetPressure`。
- **可见面**：驾驶舱健康区在存在该维度时渲染醒目提示，写清「N 个岗位 / M 个回合 / 窗口小时数 / 最早时刻」；无该维度不渲染。

## Impact

- Affected specs: `agent-fleet-cockpit`（MODIFIED：健康聚合一览 + 3 个场景）
- Affected code: `server/fleet-events.js`（枚举 + 匹配表）、`server/routes/fleets-db.js`（`budgetPressure`）、
  `server/routes/fleets.js`（cockpit health 投影）、`web/src/pages/FleetsPage.tsx`（提示条）、5 个 locale
- 无迁移、无新表、无新 env（聚合是读时计算，不落存储）。
- 既有 `model_upstream` 语义不变：真正的上游故障仍归该类。
