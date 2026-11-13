# Design: add-fleet-orchestration

> explore 底稿 §五(代数)+Q2/Q3/Q9/Q10 决议。第一波只做 DAG(无环);有界环随第二波 fanout。

## D1 · orchestration 段是纯声明,trigger/report 边零行为

`edges` 存进 fleet 对象(fleets 表新列 `orchestration`,JSON,幂等 ALTER 先例)。**trigger 边不重新物化**——它就是既有 cadence 的图形态描述,节奏物化照走 reconcile(单一定源);report 边同样只描述既有报数通道。本 change 的运行期新行为**只有两处**:dispatch_post 工具(按需)与 handoff 完成触发(收口挂点)。这个「描述与执行分离」让 schedule 等价成为结构事实而非测试巧合。

## D2 · 图校验纯函数(`server/fleet-orchestration.js`)

`validateOrchestration({members, orchestration})`:边引用存在、kind 合法、handoff 子图无环(拓扑排序)、链长 ≤ maxChainDepth(默认 8)、span ≤ spanMax(默认 8,警告)、budgetPerEdgeMin 合法(默认 10)。mode 展开:`schedule` → 空边集;`supervisor` → 每岗→每岗 dispatch 全许可(禁止表);`pipeline` → 声明 handoff 链。mode 与显式边合并后统一校验,展开只发生在读时,不落库展开结果。

## D3 · dispatch 走 delegation 车道,零新执行路径

`dispatch_post`(fleet-mcp 新工具,回环桥 `/api/fleets/dispatch`):
- 桥服务端解析归属(resolveAttribution 既有)→ 派发岗;目标 ref → 同舰岗位校验;
- 护栏五连:同舰队/非自派/目标深度<1(delegation 道界)/每岗每回合≤3(in-memory per-turn 计数)/舰队每小时≤30(db 事件流聚合,`listFleetTurnEvents(source=delegation)` 一小时内行数——零新存储);
- 通过 → `engine.createManualTask({persona: 目标岗 rosterPreset, prompt: 派发者身份+brief, initiator: 派发岗会话, origin: {fleet:{fleetId, memberId: 目标}}})`——聚合器自动把结果回投派发岗会话(下回合注入),O1 收口自动产事件(证据链 origin.fleet → source=manual…等等,initiator 在 → source=delegation,对——手动任务的 initiator 使 O1 判 delegation)。
- 深度记账:派发产生的回合本身 depth 由 turn-contract 派生(manual+initiator→depth 0?a2a 才 1)——**修正**:turn-contract 的 depth 现按 targetType 定,派发深度须显式。manual 任务缺深度位 → 深度写进 `origin`(origin.fleet.depth),`buildTurnRequest` 从 evidence.origin.fleet.depth 读,缺省 0。contract 的 MODIFIED(按道分界)即落此处。

## D4 · handoff 挂在 O1 收口,一跳一任务

`runCronJobTurn` wrapper(O1 同一缝)回合结束后:`fleetOrchestrationFor(memberId)` 查出边 → 每条 handoff 创建 manual 任务(prompt = 上游 brief 产出引用 + 失败摘要 + 链位,`origin.fleet.{memberId: 下游, depth: 链位+1, chainBudgetMs}`)。链位与预算合计记在 origin,逐跳 O1 事件天然形成审计链。链位 ≥ maxChainDepth → 不建任务,记一条 O1 事件(status=ok, error="handoff depth bound reached")如实留痕。失败也接棒(D 语义:如实转述不重试)。

## D5 · 等价门与测试

schedule 等价 = 十套既有回归零新增红(结构保证:无段=无新代码路径执行)。新套件 `test-fleet-orchestration.mjs`:图校验矩阵(合法 trigger/report/dispatch/handoff、环拒、链深拒、跨舰拒)、dispatch 护栏全拒绝面、dispatch 闭环(注入 executor 断言任务创建形状)、handoff 接棒(上游 ok/failed 两态)、mode 展开三例、深度分道断言。

## D6 · 明确不做

fanout/rounds 环/裁决聚合、event 边(第二波);T1 skill 岗(独立 change);架构师 NL 编边(v1 架构师只编结构,如实记);跨舰队派发;自动重试;黑板。
