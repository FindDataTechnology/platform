# add-fleet-ops-canvas — 实施任务

## 1. 实时粒子层（design D1）

- [x] 1.1 fleet-store `recentResults` 环：`fleet_turn_ended` 时写入 `{turnId: {status, endedAt}}`（仅留最近 40 条，过窗清），回放态不记结局。
- [x] 1.2 新组件 `web/src/components/fleet/ParticleOverlay.tsx`：在 React Flow 容器上层 position:absolute SVG，按 `liveTurns ∪ recentResults(2s 窗)` 分组到 `from→to:edgeKind` 边键，getBezierPath 复用同边曲线；CSS offset-path 动画，�max 6 点/边，支持 `FLEET_OPS_OVERLAY=off` 闸。
- [x] 1.3 边色映射：类型色=KIND_COLORS[edgeKind]；`recentResults` 中 endedAt+2s 窗内 failed 切换 #ef4444（红）；end 完好半红色淡出 2s。
- [x] 1.4 Safari 降级：`CSS.supports("offset-path", "path('M0,0')")` false 时整层隐藏并渲染零内容；失败不改原 flow 动效。

## 2. 节点内嵌迷你 span（design D2）

- [x] 2.1 `web/src/components/fleet/MiniSpan.tsx`：hover/选中时 fetch `/members/:mid/turns?limit=1` 取最近阵（traceTurnId），再 fetch `/api/trace/turns/:traceTurnId`，30s LRU（每 fleet ≤8 条）缓存。
- [x] 2.2 渲染：过滤 tool 事件，行=名称 + ok|failed 徽标 + durationMs（start/end 配对）+ errorKind（仅 failed 时）；无 tool 事件整块不渲染。
- [x] 2.3 失败摘要行锚点可点击 → 直达对应回合会话锚，`data-testid="mini-span"` 供 e2e。

## 3. 配置栏（design D3）

- [x] 3.1 cockpit 聚合 members[] 增列 `latestTurnUsage: {input,output} | null`（既有 SELECT 多带两列，不加端点）。
- [x] 3.2 新组件 `web/src/components/fleet/FleetConfigBar.tsx`：四件卡布 = 模型分布 pills / effort 直方图 / contextBudget 用量桶（0-25/25-50/50-75/75-100/over）/ 24h 边流量热度图（edgeTraffic[]）。
- [x] 3.3 热度图着色：ok/total 插值绿→红；turns=0 灰；`over` 桶 red flag。位置=画布上方（纯读、无交互副作用）。

## 4. bot 一等公民（design D4）

- [x] 4.1 routes/fleets.js memberView 对 target.kind=bot 附 `bot` 摘要子对象（best-effort 映射 bots 存储，列缺→null）。
- [x] 4.2 画布：kind=bot 节点改 BotPlatformIcons；persona/cluster/a2a 不变；bot 状态副点。
- [x] 4.3 检查器 config tab：bot 类岗位 top 部摘要行 + 链接 BotsPage 对应 bot 卡。

## 5. i18n、e2e 与验证

- [x] 5.1 i18n 五语言（en/zh-CN/es/fr/ja）：粒子层徽标签、迷你 span 占位、配置栏四件卡名、bots 摘要行的全部新键；check-locales 过闸。
- [x] 5.2 e2e（`e2e/fleets.spec.js` 扩面）：
  - a. 粒子：dispatch 一回合（bot 接 200 mock inline fixture），断言粒子节点出现；回合结束 2.5s 后断言消失；
  - b. 失败→红：陈树直接 mock 注入造失败回合，断言粒子 .failing 类；
  - c. 迷你 span：hover 节点断言两行工具条目（无工具的岗位不渲染）；
  - d. 配置栏：单模型 + 双 effort 混合舰队，断言 pills/直方图/热度图的 DOM 路径。
- [x] 5.3 单元：fleet-store recentResults 环修剪；edgeTraffic 空集灰态；latestTurnUsage 注列注入。
- [x] 5.4 真机走查（2026-10-27 二轮，用户授凭据直登后完成主体：配置栏真数据/失败岗迷你 span 插值+归因/两跳数据面三眼见；拍出并修掉四缺陷见台账 §15.64。**余项挂账**：边回合粒子（本舰队 root 巡逻不触边）、bot 岗摘要目击（生产无 bot 岗车队）——均有 e2e 覆盖，待真实数据出现再补眼见。
