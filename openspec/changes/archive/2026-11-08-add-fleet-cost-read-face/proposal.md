# Proposal — add-fleet-cost-read-face

## Why

钱早就算出来了，但**只有一处存着、且没有任何读面**：

- 回合写入缝（`fleets-db.js` 的 `recordTurnEvent`）拿到 `event.pricing`
  = `{ inputUsd, outputUsd, cacheWriteUsd, cacheReadUsd, pricingAt }`，
  但**只写进 `member_turn_daily`**，回合行只留 `pricing_at` 版本戳。
- `member_turn_daily` 的键是 `(fleet, member, carrier, provider, model, day)`——
  **没有 run、没有边**。所以"这一条链花了多少"、"这一跳花了多少"根本无从得知。
- 读面因此全是 token：`/:id/spend`、owner board、`/:id/runs(/:runId)`、`/:id/cockpit`
  都只给 token；`edgeTraffic` 只有 turns/ok/failed。唯一读 USD 的地方是内部的**周报记忆摘要**。

explore P1-4 / §4.7 记的就是这条：「成本只见 token 不见钱（USD 列无读面）」。

## What Changes

- **把已经算好的四分量同时落到回合行**（`member_turn_events` 加四列，可空）。
  这不是新估算，是同一输入的第二份落点——它让 run/边 两个切面**精确且历史不变**
  （拿当下价目重算历史回合会改写历史，本方案明确不做）。
- **三个切面接线**：
  - 岗位：既有日汇总口径不变（长期趋势仍读它，永久保留）
  - run：`runCosts(fleetId,{sinceMs})` / `runCost(runId)`，随 run 列表**一次分组查询**
    整页附带（不做 N+1），run 详情与取消响应同样带
  - 边：`edgeTraffic` 增 `costUsd`（该 hop 的**下游回合**自身估算之和）
  - 花销窗口：`spendProjection` 各窗口增 `costUsd` + `pricedTurns`；owner board 的
    fleet 行累加金额
- **诚实纪律**：未定价回合不贡献金额；整组未定价时金额为 `null`（不是 0），
  并给出样本量 `pricedTurns` 与价目版本戳。金额恒为估算，不呈现为账单。

## Impact

- Affected specs: `agent-turn-metering`（1 处 MODIFIED + 1 处 ADDED）
- Affected code: `server/routes/fleets-db.js`（四列、`costOf`、`runCosts`/`runCost`、
  `spendProjection`、`edgeTraffic`）、`server/routes/fleets.js`（`runListEntry` /
  `turnTimelineEntry` / run 列表与详情 / 取消响应 / owner board）
- **有意推翻 `add-turn-pricing` 的 D4a**（"钱只进日汇总"）：那条决定让 run/边归因不可能。
  推翻的理由与"两处必须一致"的交叉校验写进 spec 与测试，不是悄悄改。
- 迁移：`member_turn_events` 加四列（`try { ALTER } catch {}` 幂等）；老行读作未定价。
