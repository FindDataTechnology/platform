# Design: add-cockpit-ux-polish

## Context

三处毛刺均有走查实录:深链竞态(会话重铸期首刷 401,页面停空)、时间线零选中、舰队回合在 TracePage 无归属标注。舰队回合自 v2 起携 trace_turn_id 入账本,关联键已在。

## Decisions

### D1 · 自愈 = 有界重试,不引入身份订阅

`loadDetail` 失败时按 capture id 排程重试(2s、4s,至多 2 次;成功清零),重试前校验 selectedRef 仍指向该舰队——会话切换/换舰自然取消。不订阅 auth ready(多一层耦合,重试已覆盖重铸窗口)。诚实空态(cockpit 404=他舰)同样重试但结果不变,无风暴(至多 2 次)。

### D2 · Trace 标注 = 服务端批量 join,纯函数可测

`routes/trace.js` listTurns 取页后收集 turn_id,一条 `IN` 查询 fleets.db(`member_turn_events.trace_turn_id` JOIN `fleet_members` 取 title),导出纯函数 `annotateFleetTurns(turns, rows)` 供单测;`fleet: {fleetId, memberTitle} | null` 挂行上。core 类型加可选字段,老数据无字段照旧。

### D3 · 默认选中 = 仅初始,ref 闸门

RunTimeline 列表首次成功装载且未选中时选中 `runs[0]`;`didAutoSelect` ref 按 fleetId 重置;后续 runsVersion 刷新不再触发。

### D4 · 行文案 = 单次岗位名

`rootMemberTitle ?? title(rootMemberId)` 渲染一次,去掉「内容部 → 内容部」式重复。

## Risks

- [重试与 WS cron 版本重拉叠加] → 重试仅失败路径触发;成功路径照旧单通道。
- [trace join 逐行 N+1] → 单条 `IN` 查询,页大小 ≤200。

## Migration

纯增量,无迁移;回滚=重部署上一镜像。
