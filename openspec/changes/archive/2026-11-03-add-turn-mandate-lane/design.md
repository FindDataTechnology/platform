## Context

编排骨架已落地：turnRequest 派生契约（agent-turn-contract）、六种编排边（agent-fleet-orchestration）、事件唤醒+cap（add-fleet-event-wake）、O1 事件收口。现行事件唤醒是「命中边即唤醒」，授权维度为空。设计宪章 `docs/agent-domain-design-charter.md` §1/§8 将授权层列为最大缺口，本案为其首批落地。锚点：`server/fleet-event-wake.js`（唤醒判定+cap）、`server/fleet-events.js`（事件通道）、`server/worker-slots.js`（槽位池）。fleet-decision-lane 已是结构化审批队列，本案不重复立项。

**红线**：现行全部唤醒路径行为逐字节不变（记账性新增 + opt-in 扩面），这是与已归档 add-turn-contract「行为不变」验收同一纪律的延续。

## Goals / Non-Goals

- Goals：单写者纪律下补授权记账面；去向账有界；复用 O1 事件通道不建第二账本；observe 研判本期用确定性规则（零模型依赖）。
- Non-Goals：研判模型引入（判据车道后续线）、auto 默认开启、mandate 与 carrier/tool_risk 闸对接、驾驶舱展示（另行）、名单自动同步（v1 手配）。

## Decisions

- **D1 mandate 挂回合创建点，不建触发实体表**：授权记录随 event 唤醒的任务创建写入（fleet-event-wake 建任务处），回合是壹座既有记账单元（O1 已锚回合）。备选：仿上游建独立 trigger/thread 实体——拒：壹座已有任务记录+O1 事件双面，再加实体即第二账本，违宪章 §2.4 单写者。
- **D2 策略版本戳 = 配置摘要 hash**：对（准入表+放量档+名单）做内容 hash，不建版本实体；变更即新戳，在途 mandate 持旧戳供重校验比对。备选：版本化 settings——拒：过度建制。
- **D3 去向账 = 每 bot 有界环，独立 JSON 落盘（实施勘误，替代原「O1 通道新类别」措辞）**：环文件 `signal-dispositions.json`（PLATFORM_DATA_DIR），写经 O1 之外的专用单写者（fleet-turn-mandate.js），防抖 150ms 异步落盘、失败只降级观测。环上限 200（env 可调）。原设想「O1 事件通道入站侧新类别」不可行：appendTurnEvent 表按 fleet+member 无界增长，环语义不适配；cap-refused 的 O1 留痕保持原样，去向账另行记录同一事实（两账同框）。备选独立 sqlite 表——拒：观测面不配新表（维持）。
- **D4 observe 研判 v1 = 确定性规则**：would-accept 判定用（点名/名单/边匹配）纯规则，不接模型。备选：直接用判据模型（minimax 车道）——拒：本期红线是行为不变，模型研判是行为变更且引车道抖动；后续线引入时沿用判据纪律（503 且 <200ms 先查模型名、禁自证）。
- **D5 人优先槽 = cap 外常备 1 槽、只出不进**：仅人的消息/状态查询可用；分配次序「唤醒优先于新启动」在 slot dispatcher 一处实现。备选：动态抢占在办任务——拒：不可中断执行（宪章 §3 会话粒度裁决同理）。实施细化：extra 槽只在 cap 满时物化（空池的人唤醒走 cap 内常规位）；其领取须与 spawn 决策同步簿记（spawn→run 异步隙，与 pendingFleets 同类竞态，测试逮住后已修）。
- **D6 准入表默认值 = 现行行为编码**：命中边接收范围=explicit，其余格=忽略；表随信号源配置落（bot 信号源段），主人不改即零扰动。备选：全局默认表——拒：准入是每源属性（宪章对上游 002 的采纳）。
- **D7（实施新增）重校验走任务引擎单缝**：`setMandateGate(fn)` 钩子（仿 setSlotDispatcher 先例）挂在 enqueueExecution 的 queued/running 短路之后、state 置位之前——run-now/re-run/repair 全部过此一缝；server.js 接线（持有 fleet db + 策略读面），fail-open。ok+stampChanged 的「通知」落去向账（admitted/revalidated_stamp_drift），不写合成 O1 行（回合自身会写真实行）。
- **D8（实施新增）humanPriority 的盖章缝 = 拍板送达 execute-now 三处**：owner 批复的 execute-now 是人工唤醒的物化；runJobNow（重跑既有任务）不盖章——给任务记录永久盖章会让后续 cron 火也占额外槽，语义错。chat 委派（agent  mediated）不盖章。edge wake / cron / delegation 永不携带。

## Risks / Trade-offs

- [去向账写盘增加 bot 入站路径延迟] → 防抖 150ms 异步写入；记账失败只降级观测、不阻断入站与唤醒
- [默认表编码与现行判定有偏差=行为漂移] → 任务内含逐字节一致性验收：构造现行全部唤醒场景（命中/未命中/cap/守卫）前后对照
- [有界环与「审计无限期」期望冲突] → O1 事件仍为长期真账本；去向账定位为快照观测面，上限 env 可调并在文档声明
- [人优先槽与 cap 语义混淆] → 测试钉死多态：额外槽仅人可用/新启动永不占用/额外槽单例/cap 0 休眠/reap 释放后队首人唤醒获槽；spec 三 scenario 全覆盖
- [策略版本 hash 漏字段导致重校验假通过] → hash 输入字段清单在代码单点声明并被测试断言（防漂移）
- [humanPriority 盖章缝不全（runJobNow 重跑不盖章）] → design D8 明写边界与理由；漏盖的后果仅是排队不插槽（安全侧），不产生越权

## Migration Plan

纯 additive：上线即默认 off + 默认表（零扰动），去向账写入有 env 开关（关闭即回滚到纯现行行为）。无 schema 破坏性迁移；环记录表随首启建。worker 池人优先槽在 cap 0 下天然休眠，生产开启即生效、无需回滚预案。

## Open Questions

- ~~显式接受规则的具体形态~~ 已定（实施）：结构化 JSON —— `rules: [{ id, target, keywords? }]`，`target` 兼任路由（指向成员 id），`keywords` 缺省匹配任意候选。
- 名单来源是否接群成员自动同步——v1 手配；接同步时须满足宪章 §2.2（同步结果影响重校验而非撤销在途）。
