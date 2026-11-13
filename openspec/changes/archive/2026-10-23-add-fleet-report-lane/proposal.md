# Proposal: add-fleet-report-lane（报数通道与巡视上下文注入）

## Why

刀1（add-fleet-core）给出组织骨架，但岗位只有调度视角的状态（在跑/失联），没有业务视角的状态：管理面看不到「电商本周 $309」「开源 ★+47」这类岗位自报的最新指标，上级岗位（CEO 巡视）在触发回合时也拿不到下级的最新汇报——今天 cron 的 prompt 是静态串，层级只是装饰。本 change 建立舰队的报数通道（岗位自治回合以结构化工具上报状态）与巡视上下文注入（触发时服务端把下级最新报数与舰队状态插值进 prompt 模板），使组织树「活」起来，并为刀3 拍板通道与刀4 驾驶舱 KPI 卡提供唯一数据面。

## What Changes

- 新增 `report_status` 工具：舰队成员回合内可调用，按岗位 KPI 槽位上报结构化状态（metrics 按槽 key 对齐、resources 受管资源清单、blockers 阻塞项、summary 人读摘要）；append-only 落库 + 岗位级 latest-wins 读视图。
- 槽位制约束：卡片槽以岗位声明的 kpiSlots 为准，未声明 key 的指标进详情不进卡；报数体积与频率设上限。
- 报数归属解析：persona 岗位按当前 preset 解析、cluster 岗位按 clusterId 解析、a2a 岗位诚实降级为「执行摘要」（无自报工具可达，latest 视图由最近回合结果生成，明确标注非自报）。
- 新增巡视上下文注入：岗位 cadence.promptTemplate 支持 `{{fleetContext}}` 占位符，触发时服务端把「直接下级岗位的 latest 报数摘要 + 本岗位未决/已批拍板（刀3 前仅报数部分）+ 舰队在岗概况」渲染为上下文注入 prompt；无占位符的模板保持原样（零行为变化）。
- 报数历史读面：岗位详情可见报数时间线（含所属会话链接）；失联判定（刀1 的 missing）升级为「无执行或报数超窗」。

## Capabilities

### New Capabilities

- `agent-fleet-report-lane` — report_status 工具契约、槽位制报数存储与 latest 视图、a2a 诚实降级、巡视上下文注入、报数时间线读面。

### Modified Capabilities

（无——task-engine 触发链仅由注入层消费 promptTemplate，不改其既有需求；工具面治理按既有 PACK_TOOL_FACE_GATE 并集规则自动生效。）

## Impact

- **代码**：`server/fleet-report-store.js`（新，落 fleets.db 或独立表）；`report_status` 工具注册进本地 MCP 配置（沿 scheduling-tools 的注册模式）；cron.js 触发路径在 enqueue 前做模板插值（对非舰队任务零改动）；fleets 详情 API 增报数读面；FleetsPage 岗位卡渲染 KPI 槽值。
- **依赖**：add-fleet-core（岗位/槽位/物化任务）；工具须经 FULL_MODE_TOOL_SCOPE/PACK_TOOL_FACE_GATE 治理面。
- **后续刀接口面**：latest 视图是刀4 驾驶舱 KPI 卡与拍板 recommendation 上下文的唯一来源；注入器是刀3 批复回注的同一管线。
