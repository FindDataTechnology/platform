# Proposal — add-fleet-ruling-ledger

## Why

汇总/裁决回合是**唯一不经过任务引擎**的舰队回合：聚合器直接向发起会话下发 prompt。
于是它三处都缺席（explore P1-3）：

- **没有 O1 行** —— 战术面板/时间线上根本看不见这一回合，它说过什么只能翻会话；
- **没有 run 头表关联** —— 那次裁决的 token 不进本 run 的合计，也不进成本读面；
- **没有链位** —— 裁决回合内起的下一波派发无法挂到它下面，「多轮辩论」在账本上不成立。

而规格早已要求裁决回合存在（`agent-fleet-orchestration`「裁决回合」场景），也要求
run 以 `runId + parentTurnId + edgeKind` 还原成树。**回合在跑，账本里没有它。**

## What Changes

- **点火侧记下发起岗**：三类 hop（接棒 persona/a2a、接棒 tool、扇出）在 `origin.fleet`
  里带上 `byMemberId`——无裁决波的汇总发言人是"点火那个岗"，而现有数据里没有它。
- **汇总回合开成 run 的节点**：注入前用合成 job（`sourceTag` + `origin.fleet.chain`）
  `begin` 一个回合，结束后 `end` 写 O1 行（含 usage），再 `settle` 收口该 run。
  - 归属：裁决波由 `fleet:<fleetId>:<judgeId>` 解出；无裁决波取 `byMemberId`；
    两者皆无 → 不造节点（诚实空缺）。
  - 边种类：沿用该波的 `edgeKind`（fanout），父回合为该波的 `parentTurnId`。
- **两条注入路径都收口**：collector 路径拿 `collectTurn` 的 `{text,error,usage}` 精确落账；
  live 路径的 usage 走 dsh-events、此处不虚构，如实落"无 usage"。
- **降级放行**：账本未挂载/开节点抛错只记警告，汇总照发。

## Impact

- Affected specs: `agent-fleet-runs`（1 处 MODIFIED + 1 处 ADDED）
- Affected code: `server/fleet-handoffs.js`（`byMemberId`）、
  `server/delegation-aggregator.js`（`rulingTurnIdentity`/`rulingTurnJob` + 注入前后开合）
- 无迁移、无新表：复用既有 run/回合表与账本 API。
- 顺带修正 `server/fleet-events.js` 里因 ⑪ 过时的 D4a 注释。
