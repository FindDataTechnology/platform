# fix-fleet-failure-visibility Design

## Context

`deriveMemberStatus`（server/fleet-reconcile.js:214）是纯函数，读 `{member, fleet, task, targetAlive, latestReport, now}` 出状态。它拿不到回合历史——`task.lastRun` 只回答「最近什么时候跑过」，不回答「跑成了没有」。

失败数据在别处，且已经齐备（`member_turn_events` 表）：

- `consecutiveFailures(memberId)`（fleets-db.js:750）从最新往回走，遇非 `failed` 即停——语义正是「连败」；
- `latestTurnFor(memberId)` 给出最近一回合的 `status` / `errorKind` / `error` / `endedAt`；
- 调用方 `memberView`（fleets.js:205）已经同时持有 `derived`、`lastTurn`、`consecutiveFailures` 三样东西，只是**没让它们互相说话**。

前端已经有 `×N` 角标（`consecutiveFailures >= 3` 才显示），说明数据面早就到了 UI，缺的是「状态本身变色 + 统计口径」。

## Goals / Non-Goals

Goals：连败达阈值的岗位在**状态**上降级（不只是旁注）；降级依据（连败数/起始时刻/最近类别）三面可见；`statusCounts`/`health` 口径与状态一致；恢复全自动。

Non-Goals：不改回合执行路径、不加/改重试语义（需求稿 §二 已有有界等待，本 change 不碰）、不碰模型链与熔断（§四）、不做 timeout 归因（§三）、不改 `missing` 的判定口径。

## Decisions

### D1 — 连败判定复用既有 `consecutiveFailures`，不新建计数

`consecutiveFailures` 已经是「从最新往回数，遇非失败即停」，正是需要的语义。新建独立计数器只会引入双写不一致。**中断不计入**这一条已由既有实现保证（只认 `status === "failed"`），无需改动——这里只是把既有事实写进 spec。

代价：每次读取要扫该岗位全部回合行。实测单岗位回合数在百量级（最长连跑十余天的小时岗），SQLite 上是一次索引扫描，与既有 `latestTurnFor` 同量级。不做物化计数（spec 原文「不要求独立计数」）。

### D2 — 阈值默认 3，env 可调，且只在 `on_duty` 分支生效

`PLATFORM_FLEET_FAILING_STREAK`（默认 3）。判定位置：`deriveMemberStatus` 的 `on_duty` 返回点——`missing`/`paused`/`passive`/`vacant` 四档**不参与**（它们各自表达更明确的失效形态，叠加只会让运维困惑；失联优先于需关注这条在 spec 里写明）。

### D3 — 状态判定需要连败输入，但 `deriveMemberStatus` 保持纯函数

新增可选入参 `failureStreak`（默认 0）与 `lastFailure`（最近失败回合的 `{errorKind, endedAt}`）。调用方 `memberView` 已经查过 `consecutiveFailures` 与 `latestTurnFor`，直接传进来即可。保持纯函数是既有测试与 reconcile 复用的前提（`deriveMemberStatus` 在 reconcile 与 routes 两处被调）。

**备选被否**：让 `deriveMemberStatus` 自己查库——会破坏它的纯函数性，且 reconcile 侧没有 db 句柄。

### D4 — `failingSince` 由连败区间的最早时刻推导，不存储

连败区间 = 从最新往回所有 `failed` 行。`failingSince` = 该区间最早一行的 `startedAt`。需要一次带 `startedAt` 的查询——把 `consecutiveFailures` 的 SELECT 从 `status` 扩成 `status, started_at, error_kind`，一次查询同时供连败数、起始时刻、最近类别三用，不增加查询次数。

### D5 — `health.failing` 改由状态派生

现在是 `members.filter(m => m.status === "on_duty" && m.lastTurn?.status !== "ok").length`——「最近一回合失败」的独立口径，与状态无关。改成 `statusCounts.failing ?? 0`，口径与状态一致：`normal` 不再包含连败岗位，`failing` 独立计数。旧口径漏掉了「连败但最近一回合恰好成功」的中间态，新口径不会。

### D6 — 前端着色用既有状态色板，不新增设计语言

`failing` 用琥珀/警示色（与既有 `missing` 的红、`paused` 的灰区分开），文案「需关注 / 连续失败 N 次」。五语言键齐（`fleets.status.failing` + `fleets.failure.*`）。画布节点、岗位卡、检查器三处同色同文案。

## Risks / Trade-offs

- [上线瞬间大量岗位变色] → 预期效果：那些岗位本来就已经坏了（普查 74% 失败率），只是没人看见。台账会记这一批。
- [阈值 3 对小舰队偏敏感（一天 3 轮全败就红）] → env 可调；且连败 3 轮在无人值守场景下确实该被看见。
- [每次读取多扫一段回合行] → 与既有 `latestTurnFor` 同量级；不做物化。
- [状态枚举新增值可能让前端未知态渲染空白] → 前端状态映射表补 `failing`，并确认默认分支不崩（既有代码用查表 + 兜底）。

## Migration Plan

纯读时派生，**无数据迁移**：上线即生效，无需回填。回滚 = 回滚镜像；`failing` 消失后岗位回到 `on_duty`，无残留状态。

## Open Questions

（无。）
