# Proposal: add-cockpit-ux-polish

## Why

v2 上产走查暴露三处毛刺:①驾驶舱首刷失败(会话重铸/网络)页面停在空列表,须手动刷新才自愈;②执行时间线打开后不选中任何 run,看瀑布总要多点一下;③舰队回合已进 trace.db,但 TracePage 列表不标舰队归属,观察闭环差最后一环。

## What Changes

- 驾驶舱聚合读面拉取失败自愈:有界自动重试(2s/4s),恢复后呈现最新数据;同舰队会话切换的诚实空态不受影响。
- 执行时间线首次呈现默认选中最新一条 run(仅初始;新 run 到达不跳选)。
- 时间线 run 行根岗位重复渲染修正(「内容部 → 内容部」→ 单次)。
- Trace 回合列表为可关联的舰队回合标注岗位名并提供舰队入口(服务端经 trace_turn_id 批量关联,一次查询)。

## Capabilities

### New Capabilities
(无)
### Modified Capabilities
- `agent-fleet-cockpit`: ADDED——聚合读面失败自愈(有界重试)与执行时间线默认选中最新 run(仅初始)。
- `agent-fleet-runs`: ADDED——Trace 读面按 trace_turn_id 标注舰队岗位名并提供舰队入口;不可关联回合照旧。

## Impact

- 后端:`server/routes/trace.js`(listTurns 批量关联 fleets.db,纯函数 annotateFleetTurns 可单测)。
- 前端:`FleetsPage.tsx`(重试)、`RunTimeline.tsx`(默认选中+行文案)、`TracePage.tsx`(徽章+入口)、`packages/core/src/api/trace-api.ts`(类型)、i18n 五语言一键。
- 非目标:不改 trace 存储结构;不做跨设备同步;不给 TracePage 加过滤维度。
