## Why

2026-10-31 深夜「本体建设舰队」（五岗流水线：盘账→建模→校验→提案→主编）首链人工点火实录，四腿全跑通并产出 3 条落闸提案，但暴露三处平台结构性缺陷（链路能跑通全靠退化路径硬撑）：

1. **handoff 边不授权 dispatch_post**。蓝图声明了 4 条 handoff 边（流水线的全部协作意图），建模腿经 `dispatch_post` 向校验腿移交时被拒：`no dispatch edge or supervisor mode grants this pair`——校验腿向建模腿退回拦截件、向部署腿移交过闸件，两个方向全部被拒。退回语义只能改走 cell 工作区文件+报数摘要投递（reviewer 已 escalate 建议 declare_edges）。根因：`dispatchAllowed`（server/fleet-orchestration.js:239）只认 `kind:"dispatch"` 边与 supervisor 模式；而 pack 发布门**禁止声明 handoff 环**，所以「 declare 一条 dispatch 回边」不是可用出路——流水线舰队结构性拿不到运行期派活许可。spec `agent-fleet-orchestration` dispatch 需求明写「显式 dispatch 边或 supervisor/**pipeline** 模式展开」，实现注释（D2/grill Q3）却定死「schedule/pipeline 不做隐式展开」——spec 与实现已经打架。
2. **本岗声明的 KPI 槽位键对岗位不可见**。五岗报数全部 `slotsUnrecognized`（reviewer 原话「本岗声明的 KPI slot keys 在 spec 中不可见」）。库里 `kpi_slots` 落位正确、报数归因正确——缺的是回合上下文从不把本岗声明的槽位键告诉岗位，agent 只能自造键名；`report_status` 的 `UNRECOGNIZED` 提示让 agent「re-check your post's declared slots」，但没有任何面能让它 check。
3. **回合预算写死 10 分钟且提案腿被吃满**。`runCronJobTurn` 硬编码 `10*60*1000`，cadence 无覆盖口。提案腿 10 条过闸声明逐一 `wire_action_propose`，上游车道抖动叠加重试把 10 分钟吃满 → `turn timed out`，10 条只落了 3 条；且该超时对「上游慢但能成」的场景没有任何调节面。

无真实客户在产，三处都该治本而不是靠舰队 prompt 绕。

## What Changes

- **① handoff 边授予成对 dispatch_post**（`server/fleet-orchestration.js dispatchAllowed`）：声明了 handoff 边的两岗之间，dispatch 许可**双向**成立——正向=移交（上游→下游），反向=退回（下游→上游，拦截件退回建模腿的语义承载点）。这是**沿已声明边**的许可，不违背 grill Q3「未声明不授权」的裁决；与 spec 既有句「supervisor/pipeline 模式展开」对齐。跨舰队、自派、深度与频次护栏全部照旧。
- **② 本岗声明槽位键注入回合上下文**（`server/fleet-context.js renderSelfBlock`）：本岗位自身块追加一行声明槽位清单（键/label/unit），岗位每回合都能看到自己该用什么 metrics 键；`/api/fleets/report` 响应补 `declaredSlots`，UNRECOGNIZED 提示从「去查」变成「这就是」。
- **③ 舰队成员回合预算可按岗位声明**（`server/cron-runner.js runCronJobTurn`）：成员 `cadence.turnTimeoutMs`（有界：2–30 分钟，界内生效、越界取界、未声明=默认 10 分钟不变）生效于舰队成员回合；普通定时任务与本值无关，mcp-integration 凭据交付硬顶语义不动（硬顶仍按最长单回合预算口径）。

## Capabilities

### Modified Capabilities

- `agent-fleet-orchestration`: dispatch 许可来源增加「声明 handoff 边的成对双向授权」；新增场景：正向移交、反向退回、未声明仍拒。
- `agent-fleet-report-lane`: {{fleetContext}} 本岗块内容增加声明槽位键清单；报数响应补 declaredSlots；新增场景：岗位按声明键报数零 UNRECOGNIZED。
- `cron-module`: 新增需求「舰队成员回合预算可按岗位声明」——cadence.turnTimeoutMs 有界生效，默认行为逐字节不变。

## Impact

- `server/fleet-orchestration.js`：dispatchAllowed 加 handoff 对授权（纯读时判定，不落盘、不进 expandedEdges）。
- `server/fleet-context.js`：renderSelfBlock 加一行；截断预算不变。
- `server/routes/fleets.js`：/report 响应体加 declaredSlots（纯增列）。
- `server/cron-runner.js`：runCronJobTurn 超时来源加 member.cadence.turnTimeoutMs 解析（有界钳制）。
- 测试：test-fleet-orchestration.mjs / test-fleet-report-lane.mjs / test-cron-round-rotation.mjs 各补场景。
- rollback：三处均为行为增列，revert 即回旧口径；无迁移、无存储格式变化。
- pack 侧跟进（不在本 change）：ontology-builder 的 deployer promptTemplate 补「先查 pending 跳过已提名」，配合提案幂等；挂 fleet-packs 仓。
