# Design — add-fleet-cost-read-face

## D1 钱要落在回合行上（有意推翻 add-turn-pricing D4a）

D4a 当年的理由是「估算不冒充账单，钱只进日汇总」。这个理由在**只读长期趋势**时成立，
但代价是：run 与边两个切面在结构上不可能——`member_turn_daily` 的键
`(fleet, member, carrier, provider, model, day)` 没有 run_id、没有 edge_kind。

三条候选路，只有第三条真的可行：

| 方案 | 结论 |
|---|---|
| 用当下价目重算历史回合 | ✗ 价目会变，历史金额会跟着变——等于改写历史 |
| 从日汇总按成员/模型摊到 run | ✗ 摊派是编的，不是观测 |
| **回合时把同一分量也写进回合行** | ✓ 同一输入、同一时刻、同一价目戳，历史不变 |

所以是「同一输入的第二份落点」，不是新的估算逻辑：`recordTurnEvent` 里已经有
`pricing.inputUsd/outputUsd/cacheWriteUsd/cacheReadUsd`，只是此前只喂给日汇总。
两份**必须一致**——这由测试交叉校验（回合行值 vs 日汇总累计值），而不是靠约定。

**"不冒充账单"的纪律照旧保留**：金额带 `pricingAt` 版本戳、带 `pricedTurns` 样本量，
命名与注释都写明 estimate。

## D2 run 切面：一次分组查询，不做 N+1

列表页最多 100 条 run，若逐条算就是 100 次 SQL。做法是 `runCosts(fleetId,{sinceMs})`
一次 `GROUP BY run_id` 返回 `Map<runId,{usd,pricedTurns,turns}>`，页面逐条取用；
详情/取消走 `runCost(runId)`（单条）。两者 SQL 同源，测试断言整页读数与单条读数相等。

`sinceMs` 跟随列表的 `since` 过滤，保证"这一页看到的花费"与"这一页看到的回合"同窗口。

## D3 边切面：hop 的成本是**下游**回合自己的成本

`edgeTraffic` 现有的 JOIN 是 `child.parent_turn_id = parent.turn_id`，即每一行代表
一次"上游→下游"的 hop，主键事实落在**下游**行（`c`）。因此金额取 `c` 的四列之和——
这也符合直觉：这次跳转花了多少钱，就是下游那次执行花了多少钱。上游那次的成本属于它自己
那一跳（或根回合），重复计入会把同一次执行算两遍。

`pricedTurns > 0` 才给金额，否则 null：不能让画布画出一条 `$0.00` 的边——那是"没测到"，
不是"免费"。

## D4 空舰队与空窗口

`spendProjection` 的 `costUsd` 用 `SUM(...)`；SQLite 对空集合返回 NULL，
`priced_turns = 0` 时显式落 null（不做 `?? 0`）。理由：0 与"没有已定价回合"是两件事，
前者会被读成"这月很便宜"。token 侧既有的 null 语义（`usageInput: null`）与此一致。

## R1–R4

- **R1 两份漂移**：同一缝产出 → 天然一致；测试逐回合交叉校验（`t.cost_cache_read_usd`
  vs `daily.cost_cache_read_usd`）。将来若有人只改一处，那个断言会红。
- **R2 历史行**：老回合行四列为 NULL → `costOf` 返 null → 各切面把这部分算作"未定价"，
  金额与样本量都如实缩小；不会出现"老数据被补成 0"。
- **R3 裁剪**：回合明细有滚动裁剪（保留窗 + 最近 N 条），run 头行也按窗清理。因此
  超出保留期的 run 与边**读不到金额是既有语义**（那一跳的明细已被裁），日汇总仍永久保留，
  长期趋势走日汇总口径。这一点写进 spec 之外的说明，不假装能追溯。
- **R4 金额量级**：USD 是 REAL，累加用 SQLite SUM；四个分量各自为 null 时按 0 计入和
  （只在"该分量无价"时发生，同回合其他分量仍计价），这与日汇总的累加口径一致。
