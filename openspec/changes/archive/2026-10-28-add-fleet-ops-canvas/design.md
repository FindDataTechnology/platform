# add-fleet-ops-canvas — 设计

## Context

驾驶舱 v2（agent-fleet-cockpit）已落：React Flow 画布（@xyflow/react）、LiveTurn 实时车道（fleet_turn_started/ended，含 parentMemberId × edgeKind）、回放态（replayTurns 与活体同形）、24h 边流量 `edgeTraffic`（fleets-db JOIN member_turn_events，按 from×to×kind 聚合 ok/failed）、成员回合页（/members/:mid/turns 带 traceTurnId）与回合详情（/api/trace/turns/:id 全事件）。见 proposal.md — Why。

约束：proposal 明说「不引入新 API 端点」「不引入新存储」「canvas 重排只在成员/边变化时发生」。四件必须把**数据面**全部支撑在现已存在的读面上。

## Goals / Non-Goals

**Goals:**
- D1 运行时数据流粒子层：边级粒子动画，密度 ∝ 在途回合数，红=失败，衰减窗淡出，回放态冻结。
- D2 节点内嵌迷你 span：post 卡 hover/选中时内嵌最近回合工具瀑布，两跳现成端点，不渲染空占位。
- D3 配置栏（fleet-config-overview）：纯读面聚合——模型分布、effort 分布、contextBudget 用量直方图、24h 边流量热度图。
- D4 bot 一等公民（agent-fleet-core delta）：MemberView 对 bot 类岗位附 bot 摘要；画布与检查器原生图标 + 状态点。

**Non-Goals:**
- 不改任何写面、不加新端点、不动 member_turn_events / trace.db 存表形状。
- 不做跨舰队聚合视图；配置栏范围=当前舰队页面内。
- bot 通道本身的机制（relay/QR/凭据）不在本 change；本 change 只做**读面看见**。

## Decisions

### D1 粒子层 = 自定义边组件内的独立 `<g>` 子层（实现修正）

初稿写 position:absolute SVG overlay——实现阶段改为**自定义 React Flow 边组件（粒子层寄宿其内）**：低于 BaseEdge 的 sibling `<g>`，圆点沿同一 getBezierPath 以 CSS offset-path 循环/淡出。理由（与初稿动机一致）：absolute overlay 需要手算 viewport 投影矩阵，多一处失配通道；自定义边天然随 pan/zoom 联滚。「独立于现有流动动效」的语义落在组件内部（`animated` prop 归边身、`<g data-testid="edge-particles-*">` 归粒子），offset-path 不支持或 `VITE_FLEET_OPS_OVERLAY=off` 时子层整体不渲染，边身无损。

替代与取舍（保留初稿结论）：
- 改边本身 stroke-dasharray 动画——失败着色与密度不可表达。弃。
- Canvas 2D 粒子系统——超规模（每边 ≤6 点）。弃。
- 绝对定位独立 SVG 层——viewport 投影手算，失配风险更大。弃。

实时性输入：fleet-store 的 `liveTurns` 已带 `parentMemberId × edgeKind`，边键 = `${parentMemberId}→${memberId}:${edgeKind ?? "direct"}`。**失败着色需求与现状的缺口**：store 在 `fleet_turn_ended` 立即 delete，不记结局。设计=store 增 `recentResults: Record<turnId, {status, endedAt}>` 环（仅最近 40 条，over 窗口自动修剪），ends 时写入；粒子渲染读「在途 ∪ 最近 2s 内结束」的合成集——衰减用 `endedAt + 2000ms > now` 的纯派生，无定时器状态。回放态：粒子输入切换为 `replayTurns`（同形），不回放结果着色（回放不记结局，静态金绿即可）。

### D2 迷你 span = 两跳现成端点 + 客户端缓存，不引入新查询路径

hover/选中 node 时：
1. `GET /api/fleets/:id/members/:mid/turns?limit=1&status!=skipped` 取最近真实回合（在途回合直接取 store.liveTurnsFor(mid)[0].turnId 的前奏）；
2. `GET /api/trace/turns/:traceTurnId` 取详情，prefetch-on-hover + 30s LRU 缓存（每 fleet ≤ 8 条），渲染时过滤 `event_type LIKE 'tool%'`，数据列：name / ok|failed / durationMs（由 start/end 事件对计算）/ errorKind。

替代与取舍：新建 `/api/fleets/:id/members/:mid/tools` 聚合端点——违反 proposal「无新端点」，弃。打 cohort trace 表的直读——协调层重复，弃。「无工具不渲染」由第三条数据驱动：无 tool 事件 → 整块不渲染。

### D3 配置栏 = 全部读 cockpit 聚合；唯一增列=每岗最近回合用量

- 模型/effort 分布：members[] 已有 `effectiveModel`、`effort`（config-dims 上产后在 MemberView 里），纯前端分桶。
- contextBudget 直方图：需要「声明上限 + 最近一次用量」。上限=members[].contextBudget；用量=** cockpit 聚合 members[].latestTurnUsage {input, output} 新列**——从该成员最近一阵 usage_input/output 直接读数（不加端点、只在既有 SELECT 上多带两列；「不算新端点」与 proposal 条文一致）。
- 24h 边流量热度图：读聚合里已有的 `edgeTraffic[]`（from/to/kind/ok/failed）→ 着色 = ok 比例插值绿→红；`turns=0` → 灰。

### D4 bot 摘要 = 在 memberView 挂只读 sidecar，而非改 member 形状

routes/fleets.js 的 memberView 对 `target.kind === "bot"` 的成员附 `bot: { enabled, lastInboundAt, lastOutboundAt, lastError }`，数据来自 bots 通道存储（best-effort：列缺给 null，绝不虚构）。画布节点 kind=bot 走 BotPlatformIcon（既有 asset），状态点覆盖 presence 色；检查器 config 页 top 卡附 bot 摘要行。**不做**至少两事：bot 心跳本身的新采集、bot 计费归因。

## Risks / Trade-offs

- **粒子层脱落**：CSS offset-path 在 Safari <16 不支持 → 降级=当 `CSS.supports("offset-path", ...)` false 时整层隐藏（画布已有 flow 动效兜底，功能无损）。
- **mini span 两跳延迟**：trace 详情端点对长回合 payload 大（含 request/response body）→ 请求层已带 timeout 与缓存限制；若延迟感受差，后续再加 `?compact=1` 收窄（不本 change）。
- **客户端 latestTurnUsage 取的是最近一阵**：跑过「大型查询」的单阵会把 histogram 推红 → 文档记「读=最近一次不重采样」的语义（意即「预算已在上阵烧过」指示器，非历史均值）。
- **bot 摘要有列就给、没列就 null**：检查器与画布只在有 bot 摘要时渲染图标附着副点，避免把「未配置」画成红。

## Migration Plan

纯前端 + API 加列：按既有平台发布流程（snapshot → image → relay → ccr → 滚产）。回滚=回滚到上一镜像；无数据迁移，无兼容窗。配置栏/粒子层初始默认开；如出现性能问题，环境变量 `FLEET_OPS_OVERLAY=off` 一键关（feature flag 挂 in-app config，default true）。

## Open Questions

- 边流量热度图的「采样窗口」是否为恒定 24h 滑动，或随用户时区对齐自然日 → 取恒定 24h（与 edgeTraffic 现默认一致），iv 现况不动。
