# Design: add-fleet-cockpit-v2

## Context

见 proposal.md「Why」。与方案直接相关的现状事实(探索已核):

- 回合收口单缝 `server/cron-runner.js:775-789`:全部执行器汇到 `ctx.recordFleetTurnEvent(job, out, …)`,且 `out.usage` 已在手(`cron-runner.js:118-121,375,550`)——只是没落列。
- 舰队回合走 session collector(`collectTurn`,`cron-runner.js:54-146`),**从不经过 web 广播路径**(`:11`),而 trace tap 挂在 `handleDshEvent` 顶部(`server/trace.js:3`)——所以今天舰队回合不进 `trace.db`;`:697` 明示包 `ctx.handleDshEvent` 不会触发。
- 三处点火点各自建任务并携带 `origin.fleet{fleetId,memberId,depth}` / `initiator`:流转/扇出 `server.js:1097-1200`、派发 `server/routes/fleets.js:598-695`、事件唤醒 `server/fleet-event-wake.js:34-71`。派发发生在**上游回合进行中**(MCP 子进程 mid-turn 调 `dispatch_post`)。
- turnRequest 纯函数派生 `server/turn-request.js:32-76`(source/depth 已从 origin/initiator 推导)。
- 架构师 draft/apply 路由 loopback-only(`server/fleet-architect.js:14,554,651,661`),校验/diff/预估/apply 逻辑在同文件内。
- 前端:React 19 / zustand 5 / echarts 6 / Tailwind 4;无图库;`FleetGraph.tsx` 的 `computeGraph` 是独立纯函数;驾驶舱一次聚合拉取 `GET /api/fleets/:id/cockpit`(`fleets.js:703-776`),刷新靠 `useCronStore` 版本号(`FleetsPage.tsx:265-278`)。
- 词汇:§十五终词已于 10-24 上产(`rename-fleet-user-vocabulary`),v2 沿用,键/字段零改。
- 在途 `fix-fleet-round-discipline`(0/14)同样改 `cron-runner.js` 单缝。

## Goals / Non-Goals

**Goals:**
- 一次迁移(全部可空新列 + 一张新表)补齐 run 实体,老行零回填、零破坏。
- 回合标识与 runId 在回合**开始**时就存在(派发/trace/开始事件都需要),结束时落行。
- 画布、时间线、回放共用一份状态源:「回放 = 把时钟换成游标」。
- 设计模式与架构师共用同一函数体,两道门一个判。

**Non-Goals:**
- 不做节点间数据流(端口/变量)编辑;不持久化用户手拖的节点坐标(v2.1 候选);不做 OTLP 导出;不给 TracePage 加舰队专属视图(舰队回合进 trace.db 后它自然可见即可);不做 WS 按 fleetId 过滤(cell 单用户,广播即 owner 作用域)。

## Decisions

### D1 · run = 头表 + 回合事件扩列;边实例不另建表

`fleet_runs(run_id PK, fleet_id, root_source, root_member_id, started_at, ended_at, status open|ok|failed|partial, turns, ok_count, failed_count, usage_input, usage_output)`;`member_turn_events` 加可空列 `run_id, parent_turn_id, edge_kind, usage_input, usage_output, trace_turn_id`,索引 `(run_id, started_at)`、`(fleet_id, run_id)`、`(member_id, ended_at)`。**边实例 = 子回合行本身**(`parent_turn_id × edge_kind`),再建 hops 表是同一事实写两遍。
备选:独立 `fleet_hops` 表——被否,派发/流转/扇出的"跳"与"下游回合"一一对应,无独立生命周期。
备选:读时沿 initiator 链回溯推 run——被否,任务记录会被清理,且 O(链长) 查询。

### D2 · 回合标识与 runId 在开始时铸造,挂在在途回合注册表;结束时落行

舰队回合进入 `collectTurn` 时:若任务携带 `chain` 则沿用其 runId,否则(根)铸 runId;同时铸 turnId;登记 `openFleetTurns: Map<sessionId, {turnId, runId, fleetId, memberId, startedAt}>`。结束单缝读出该登记落行(含 usage)并反登记。
三处点火点改为:**流转/扇出**在单缝落行之后拿到上游 `{turnId, runId}` 写入新任务 `origin.fleet.chain = {runId, parentTurnId, edgeKind}`;**派发**在路由内以派发者 sessionId 查 `openFleetTurns` 取 `{runId, turnId}` 写 chain;**事件唤醒**不带 chain(根)。
`turn-request.js` 只多派生 `chain`(读任务已带的值),纯函数性质不变(spec:派生不铸造)。
备选:在派生里铸 id——破坏纯函数与幂等。备选:结束时才铸——派发 mid-turn 拿不到上游 turnId。

### D3 · usage 直接取单缝 `out.usage`;字段按 OTel GenAI 语义命名

列名 `usage_input/usage_output`,读面键名 `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`(对象 `usage: {input, output}` 也同时给,前端用短名)。缺则空,不估算(spec)。`fleet_runs` 合计在收口时 `SUM` 自明细,不增量累加(幂等更简单)。

### D4 · trace tap 进 collector 回调

`collectTurn` 注册的回调(`cron-runner.js:83`)对每条 notif 追加 `trace.record(notif, { sessionId, turnId })`(`server/trace.js:106`),turnId 即 D2 铸造的回合标识;回合开始时 `trace.bindTurn(turnId)`(`:146`)。回合事件 `trace_turn_id = turnId`(关联键与回合标识同值,但两列分存:trace 可因保留期先消失)。沿用 trace 的去 delta 与 7 天保留;以 env `FLEET_TRACE_TAP=0` 可关(默认开)。
备选:在 `handleDshEvent` 处 tap——collector 路径不经过它(`:697`)。

### D5 · 三条舰队 WS 事件 + 客户端版本自愈

`fleet_turn_started`(开始登记时)、`fleet_turn_ended`(单缝落行后)、`fleet_run_updated`(头表 insert/收口后),经 `broadcast()`;类型加进 `packages/core/src/types/ws.ts`。payload 仅舰队域字段(spec)。前端新 `useFleetStore`(zustand):`liveTurns: Map<turnId, …>`、`runsVersion`、`replayAt: number|null`;收到事件增量更新;任何事件也 bump `cockpitVersion` 做节流(≥2s)整体重拉,断流自愈。cell 单用户,不做 fleetId 过滤。

### D6 · 画布用 `@xyflow/react`;布局种子复用 `computeGraph`

MIT、React 19、节点/边完全自渲染、内置 MiniMap/Controls/Background、`colorMode` 跟暗色。`computeGraph` 从 `FleetGraph.tsx` 抽到 `web/src/lib/fleet-layout.ts`(纯函数保留,既有结构断言不丢),输出坐标作为节点初始 position;只在成员集/边集签名变化时重算(spec:实时更新不重排)。自定义 `PostNode`(状态环 + 脉冲 + 槽位摘要)与 `FlowEdge`(类型色 + 在途时 `stroke-dasharray` 动画 + 粗细 = f(24h 回合数))。路由级 `React.lazy` 分包。
备选:FlowGram.AI(MIT,字节)——表单/变量引擎面向数据流编辑器,与"组织图+编排边"不匹配,包体与心智成本高。备选:继续手写 SVG——缩放/平移/小地图/拖线交互成本远超引库。备选:d3——太底层。

### D7 · 时间线自绘;回放 = 换时钟

瀑布用 CSS grid + SVG 连线自绘(不引第二图库;echarts Gantt 自定义成本不低于自绘)。画布渲染读 `useFleetStore` 的 `clockAt = replayAt ?? now`:节点运行态 = 存在回合 `startedAt ≤ clockAt < endedAt`;边在途 = 其下游回合在途(与实时事件语义一致)。游标拖动只改 `replayAt`;释放置 null 回实时。run 详情一次拉取后回放纯客户端。

### D8 · 设计模式走抽出的架构师函数,两道门一个判

`fleet-architect.js` 抽出 `draftFleetSpec(ownerEmail, draft)` / `applyFleetSpec(ownerEmail, draft)`(含校验、diff、预估、重校验、漂移拒绝);桥路由原地改为调用它们;`routes/fleets.js` 新增 owner 鉴权 `POST /api/fleets/:id/orchestration/draft|apply`,只允许 `fleet.orchestration` 段与成员 cadence/model 的编辑子集(设计模式所需),同样调这两个函数。前端:拖线/断边/改约束 → 本地草稿(与已落地边视觉区分)→ 调 draft → diff 面 → 确认 → apply(携 draft 原文,服务端重校验)。退出设计模式清空草稿。
备选:放开桥路由的 loopback 限制——混淆两种身份来源,否。备选:前端直接 PATCH `/api/fleets/:id` orchestration——绕过 dry-run/预估,与架构师双写路,否。

### D9 · 检查器复用既有对话框逻辑

换防/暂停/调速/补岗/审批五类操作的组件从卡片菜单与 decisions dialog 抽为可嵌入抽屉的面板,业务调用不复制;卡片上下文菜单在抽屉可用后退役。边检查器的"近 24h 经此边回合"由聚合读面新增 `edgeTraffic[]`(`parent member → member × edgeKind` 24h 计数,服务端一条 SQL)。

### D10 · 保留双条件,头表随窗

prune(每小时,挂 trace 的同一节拍):`DELETE FROM member_turn_events WHERE ended_at < now-30d AND id NOT IN (每岗最近 200)`;`DELETE FROM fleet_runs WHERE status != 'open' AND ended_at < now-30d`。env `FLEET_RUNS_RETENTION_DAYS`(30)、既有 `FLEET_TURN_EVENTS_KEEP`(200)。孤儿明细/孤儿头表按 spec 容忍。

### D11 · 词汇与 i18n

画布图例、状态环、页签、时间线列头全部走 i18n 五语言键;新键只增不改;显示词按 §十五(定时运行/产出×交付/流转/结构视图),API/存储字段零改。

### D12 · 落地顺序与并行纪律

四组任务 A(账本)→ B(画布)→ C(时间线)→ D(设计模式+检查器迁移),A 为 B/C/D 前提,B 与 C 可并行。A 中触及 `cron-runner.js` 单缝的改动收成**一个 helper 调用**(`fleetTurnLedger.begin/end`),在 `fix-fleet-round-discipline` 合入后 rebase 一次。不设 UI flag:A 不可见;B 原位替换图;C 增区;D 增开关与抽屉。

## Risks / Trade-offs

- [与 `fix-fleet-round-discipline` 同缝冲突] → A 组改动包成单 helper;其合入后 rebase;两会话约定同缝只一人改。
- [trace.db 体量翻倍(舰队回合入 trace)] → 沿用去 delta + 7 天;`FLEET_TRACE_TAP=0` 可关;出片前以一支高频舰队估行数。
- [WS 事件频率(高频舰队每回合 2 条 + run 2 条)] → payload 小;客户端整体重拉节流 ≥2s;事件只改 Map 不触发布局。
- [画布包体] → 路由级懒加载;首屏不受影响;typecheck + bundle 体积断言。
- [实时更新引发布局抖动] → 位置仅在成员/边签名变化时重算(D6)。
- [设计模式误操作] → 默认关闭、dry-run 必经、显式确认、apply 重校验;退出丢弃。
- [老事件无 runId] → 不回填;时间线只覆盖 v2 之后;岗位回合页签仍可读 v1 回合(spec 已写明)。
- [派发者 sessionId 查不到在途回合(非舰队会话派发)] → chain 置空视为根,诚实降级,不报错。
- [trace 7 天 < run 30 天] → 详情读面按 spec 标注"无 trace",不虚构。

## Migration Plan

1. 迁移为**纯增量**:新表 `fleet_runs`、`member_turn_events` 六个可空列与三索引(`fleets-db.js` 既有 `ALTER … ADD COLUMN` 守卫模式)。老行 runId 空,读面视为 v1 历史回合。
2. 任务组 A 先出片:UI 不变,仅账本开始写入;以一支真舰队跑一日后查 `fleet_runs` 收口与合计一致性,再放 B/C。
3. B 原位替换 `FleetGraph`,其余页面不动;C 增时间线区;D 增设计模式开关与抽屉、退役卡片菜单。
4. 回滚:重部署上一镜像即可——新列可空、新表无人读、WS 新事件被老前端忽略。无需 down-migration。
5. 台账 `docs/registry-maintenance.md` §9 按组记发布;§十五补记 v2 画布落地。

## Open Questions

- 用户手拖后的节点坐标是否持久化(每舰队一份 layout JSON)——v2.1 再定,不影响本 change 的规格与任务。
- TracePage 列表中舰队回合是否要标出岗位名(当前按 session 标题推导)——小改,随 C 顺手或下班车。
- 边流量窗口 24h 是否做成可配——先固定。
- OTLP 导出(接 Langfuse/Opik/Phoenix)——字段已按 OTel 命名,何时接由用户决定。
