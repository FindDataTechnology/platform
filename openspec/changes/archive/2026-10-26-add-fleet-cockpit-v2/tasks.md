# Tasks: add-fleet-cockpit-v2

## 1. 账本地基(A——B/C/D 的前提)

- [x] 1.1 `fleets-db.js` 增量迁移:新表 `fleet_runs`、`member_turn_events` 六个可空列(run_id/parent_turn_id/edge_kind/usage_input/usage_output/trace_turn_id)与三索引;验证:冷启动库与存量库两路迁移成功,`node scripts/test-fleet-core.mjs` 绿,老行新列为空
- [x] 1.2 在途回合注册表 + `fleetTurnLedger.begin/end` helper(开始铸 turnId/runId 或沿用 chain.runId;结束落行含 usage 与 trace_turn_id);`cron-runner.js:775-789` 单缝改为一处 helper 调用;验证:新建 `scripts/test-fleet-runs.mjs` 覆盖 根回合铸造/下游继承/非舰队零 run/收口幂等/合计与明细逐项一致
- [x] 1.3 `turn-request.js` 派生 `chain {runId,parentTurnId,edgeKind}`(只读任务携带值,不铸造);验证:`scripts/test-turn-request.mjs` 新增 cron 空链/delegation=dispatch/handoff 继承/派生两次相等不铸造 四场景绿
- [x] 1.4 三点火点写 chain:流转/扇出(`server.js:1097+`)用单缝返回的上游 `{turnId,runId}`;派发(`routes/fleets.js:598+`)以派发者 sessionId 查注册表,查不到则空链诚实降级;事件唤醒为根;验证:`test-fleet-orchestration.mjs`/`test-fleet-event-wake.mjs` 扩链位断言(三跳同 runId 成树),非舰队会话派发不报错
- [x] 1.5 run 头表 insert(首回合开始)/收口(最后回合结束,SUM 自明细)+ 双条件 prune(每小时;`FLEET_RUNS_RETENTION_DAYS`=30 与既有 `FLEET_TURN_EVENTS_KEEP`=200);验证:单测 过窗裁剪头表/每岗下限保留明细/单侧残留读面无错
- [x] 1.6 trace tap 进 collector 回调(`trace.bindTurn` 开始、`trace.record` 每条 notif,`FLEET_TRACE_TAP` 默认开);验证:单测 舰队回合后 `trace.db` 出现 `turn_id=traceTurnId` 行且含工具事件;开关关闭零行且回合事件 trace_turn_id 为空
- [x] 1.7 WS 事件 `fleet_turn_started/fleet_turn_ended/fleet_run_updated` + `packages/core/src/types/ws.ts` 类型;验证:`scripts/test-fleet-turn-events.mjs` 断言顺序 started→ended→run_updated、payload 仅舰队域字段无凭据无会话正文
- [x] 1.8 run 读面路由:`GET /api/fleets/:id/runs`(status/source/时段过滤,有界分页)与 `GET /api/fleets/:id/runs/:runId`(有序回合+链位+usage+trace 句柄);聚合读面增 `edgeTraffic[]`(24h);验证:路由测试 非 owner 拒绝/过滤正确/回合有序/链位可还原/edgeTraffic 计数正确
- [x] 1.9 A 组收口:舰队八套零新增红;与 `fix-fleet-round-discipline` 合入后 rebase 单缝;出片 A(UI 不变)并以一支真舰队运行一日后核对 `fleet_runs` 收口与合计一致,记台账

## 2. 活画布(B)

- [x] 2.1 引入 `@xyflow/react`;`computeGraph` 抽到 `web/src/lib/fleet-layout.ts`(纯函数与既有结构断言保留);画布组件路由级 `React.lazy` 分包;验证:`npm run web:build` typecheck 绿,首屏 chunk 体积与当前持平(体积断言脚本)
- [x] 2.2 `PostNode`(状态环/脉冲/槽位摘要/生效模型/失效回落)、`FlowEdge`(类型色/在途动画/粗细=24h 回合数)、虚拟源节点(定时/信号源)、MiniMap/Controls、多根分区、暗色跟随;验证:`e2e/fleets.spec.js` 新用例 画布节点数=岗位数+源节点数、边数=声明边展开数、隐式派发不画边仅一行聚合
- [x] 2.3 `useFleetStore`(zustand):订阅三事件增量更新 `liveTurns`、节流 ≥2s 整体重拉自愈、位置仅成员/边签名变化时重算;验证:e2e 注入 started 事件→节点在途+入边动效;ended→收束呈结果;模拟漏事件后重拉收敛;新增岗位触发重排而回合事件不重排
- [x] 2.4 结构视图(组织树)降级为折叠区保留;i18n 五语言新键(图例/状态环/源节点);退役 `FleetGraph.tsx`;验证:既有 `fleets.spec` 绿,术语卡词表与 §十五一致,`{{fleetContext}}` 注入测试不变
- [x] 2.5 浏览器眼见:公司式(CEO+三部门)与投研(pipeline+fanout+judge)两型舰队,截图入台账

## 3. 回放时间线(C)

- [x] 3.1 `web/src/api/fleets-api.ts` 封装 run 读面;run 列表区(过滤 status/source/时段、分页、空态、v1 无 runId 回合不入列);验证:e2e 过滤 failed 仅红行、空舰队呈空态文案、含 v1 回合夹具不出现于列表
- [x] 3.2 瀑布泳道(岗位×回合条、链位连线自上游条末至下游条起、回合条可读 status/errorKind/model/usage/会话链接、工具调用嵌套 span 取 trace、无 trace 标注缺失);验证:e2e 固定夹具 run(定时→CEO→投资部→开源部,投资部两次工具调用)呈三泳道两连线两 span;去 trace 夹具呈缺失标注
- [x] 3.3 游标回放:`replayAt` 入 store,画布以 `clockAt = replayAt ?? now` 派生节点/边态;释放置 null;验证:e2e 拖至投资部进行中时刻 → 投资部运行态/CEO→投资部边在途/开源部未开始;释放后恢复实时
- [x] 3.4 浏览器眼见 + 高频舰队一日 `trace.db` 行数评估记录(决定是否建议关 `FLEET_TRACE_TAP`)

## 4. 检查器与设计模式(D)

- [x] 4.1 `fleet-architect.js` 抽出 `draftFleetSpec/applyFleetSpec`,桥路由原地改调;验证:`scripts/test-fleet-architect.mjs` 全绿(行为逐项等价)
- [x] 4.2 owner 鉴权路由 `POST /api/fleets/:id/orchestration/draft|apply`(限 orchestration 段与 cadence/model 子集);验证:路由测试 同一成环草稿两门同错同拒、未鉴权与非 owner 拒绝、apply 前漂移拒绝指名岗位、桥 loopback 拒绝不变
- [x] 4.3 检查器抽屉五页签(概况/配置/回合/产出/审批)+ 边检查器(类型/两端/约束/edgeTraffic 成败分布);换防/暂停/调速/补岗/审批面板抽为可嵌入组件复用;验证:e2e 抽屉内换防含清史重开勾选完成;配置页改 cron 走既有路径且 <10min 触发确认;边检查器呈 24h 计数
- [x] 4.4 设计模式:开关(默认关)、拖线/断边/改类型约束生成草稿(视觉区分)、调 draft 呈 diff 面、成环等阻断禁用确认、确认→apply→草稿边转落地、退出丢弃;验证:e2e 拖线→diff→确认→库中出现边且列表同步;成环草稿确认按钮禁用;退出后草稿消失库无变化
- [x] 4.5 退役卡片上下文菜单与独立 decisions dialog 入口(迁入抽屉);验证:`fleets.spec` 更新后绿,无死入口
- [x] 4.6 浏览器眼见:三面齐备 + 设计模式一次真改(加一条 handoff 并确认)截图入台账

## 5. 收尾

- [x] 5.1 `openspec validate add-fleet-cockpit-v2 --strict` 绿;舰队八套 + `e2e/fleets.spec.js` 全绿;typecheck 绿
- [x] 5.2 出片(`fd-build-channel` 判路 → GHA → relay → ccr)并真机验收三面;台账 `docs/registry-maintenance.md` §9 发布记录 + §十五补记「v2 画布落地」;课程不改(词表未变)
