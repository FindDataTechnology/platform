# Proposal: add-fleet-cockpit-v2

## Why

驾驶舱 v1 呈现的是「声明」(编排边的静态 SVG 分层图)和「节点亮没亮」(每岗最近一回合),看不到**一次点火沿哪些边串成了什么**——不是前端画得不够,是后端缺一层实体:n8n 有 workflow×execution、langfuse 有 trace×observations,我们只有定义与节点态,没有「这一串回合同属一次执行、谁沿哪条边叫了谁」的实例记录。用户要的是 n8n 式活画布看整体配置、langfuse 式回放看运行过程、就地改配置;三者都压在这一层缺口上,一次补齐。

## What Changes

- **执行实例账本(底)**:turnRequest 派生增 `runId`(根回合铸造,派发/流转/扇出沿 origin/initiator 继承)与链位来源(`parentTurnId`×`edgeKind`);回合事件扩列 runId/parentTurnId/edgeKind/usage/traceTurnId;新增 `fleet_runs` 头表(来源/起止/状态/合计);保留策略改「时间(默认 30 天)+每岗至少 200 条」双条件;舰队回合在 collector 路径补 trace tap(今日舰队回合不经 handleDshEvent、不进 trace.db);新增舰队 WS 事件 `fleet_turn_started`/`fleet_turn_ended`/`fleet_run_updated`。
- **活画布(面 1)**:`@xyflow/react`(MIT)替换手写 SVG `FleetGraph`;节点状态环(待命/运行脉冲/失败/超时未报/暂停)、在途回合的边流动光点、近 24h 流量粗细、小地图/缩放/平移;复用既有 `computeGraph` 分层算法喂初始坐标;实时点亮消费舰队 WS 事件,断流回退整体刷新。
- **执行实例时间线(面 2)**:run 列表(来源/时长/token/成败,分页)+ 瀑布泳道(岗位×回合条,流转/派发/扇出为泳道间连线,工具调用为回合内嵌套 span)+ 拖滑块按时刻在画布重放。
- **检查器抽屉(面 3)**:点节点出五页签(概况/配置/回合/产出/审批),既有换防/暂停/调速/补岗/审批操作全部迁入(卡片上下文菜单退役);点边出边检查器(类型/约束/近期回合/预算)。
- **设计模式(面 1 写)**:拖线连边、改节点配置 → 架构师草稿函数 dry-run(校验+diff+成本预估)→ 显式确认 → apply;驾驶舱另开 owner 鉴权路由复用同一函数,工具桥保持 loopback-only。「拖一条边」与「跟架构师说一句话」同一条写路。
- **语义命名**:账本字段按 OpenTelemetry GenAI 语义命名(内建一流、OTLP 外接可选,本 change 不实现导出)。
- **词汇**:沿用底账 §十五终词(定时运行/产出×交付/流转/结构视图),i18n 键与 API 字段零改,不造新词。

## Capabilities

### New Capabilities
- `agent-fleet-runs`:执行实例(run)账本——runId 铸造与传播、头表与合计、按舰队/状态/来源/时段分页查询、run 详情(有序回合+链位边+usage+trace 句柄)、舰队实时事件推送、舰队回合 trace 关联、时间保留。

### Modified Capabilities
- `agent-fleet-core`:「成员回合产出回合结果事件」字段集扩展(runId/parentTurnId/edgeKind/usage/traceTurnId)与保留策略由单一「每岗 200 条」改为「时间 + 每岗下限」双条件。
- `agent-turn-contract`:turnRequest 增 `runId` 与链位来源派生,纯函数性质与现有触发路径覆盖不变。
- `agent-fleet-cockpit`:组织图改为活画布(实时状态/在途边/流量);编排区由「纯读面」改为「读面 + 设计模式(经架构师草稿通道)」;管理动作入口由卡片上下文菜单改为检查器抽屉;新增执行实例时间线与画布回放、检查器抽屉、实时点亮三项要求。
- `agent-fleet-architect`:草稿与执行两段另经 owner 鉴权的驾驶舱路由对浏览器开放,校验必经/diff/预估/apply 重校验语义逐项等价;工具桥 loopback-only 不变。

## Impact

- **后端**:`server/routes/fleets-db.js` 迁移(member_turn_events 扩列、fleet_runs 表、runId/时间索引)、`server/fleet-events.js`(写入扩列+run 头表 upsert)、`server/turn-request.js`(runId/链位派生)、`server/cron-runner.js:775-789` 单缝(usage 落列、WS 发射、trace tap 进 collector)、三处起任务点传 runId(`server.js:1097` 流转、`server/routes/fleets.js:598` 派发、`server/fleet-event-wake.js:34` 事件)、`server/trace.js`(fleet turnId 绑定)、`server/routes/fleets.js` 新读路由(runs 列表/详情)与 orchestration draft/apply 门、`server/fleet-architect.js`(抽出可复用的 draft/apply 函数)、WS 类型 `packages/core/src/types/ws.ts`。
- **前端**:新依赖 `@xyflow/react`(MIT,路由级懒加载分包);`FleetsPage` 重组为三面;`FleetGraph.tsx` 退役(`computeGraph` 保留为布局种子);新增 fleet zustand store(WS 订阅);i18n 五语言新键。`FleetPage.tsx`(万象 runner 控制台,无关)命名避让。
- **测试**:舰队八套零新增红;新增 run 铸造/传播/保留/WS/trace-tap 单测;`e2e/fleets.spec.js` 扩三面;浏览器眼见(公司式/投研两型舰队)。
- **并行纪律**:在途 `fix-fleet-round-discipline` 同样改 `cron-runner.js` 单缝——本 change 账本任务组须在其合入后 rebase,或两会话约定同缝只一人改。
- **非目标**:不内嵌 Langfuse/Opik 栈(四件套与单进程 cell 冲突);不引入 FlowGram 框架(我们是组织图+编排边,非数据流 DAG);不做节点间数据流编辑器;不改任务引擎调度语义;不改 decisionPolicy 的 UI;不实现 OTLP 导出;不改 i18n 键/API/存储字段的词汇。
