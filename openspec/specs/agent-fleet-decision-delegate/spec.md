# agent-fleet-decision-delegate Specification

## Purpose
拍板委托：主人可配置把部分待拍板项委托给一个 AI 代理（常务岗）裁决/分流/跟踪，裁决受服务端强制授权约束（越权即拒），裁决身份与依据入审计，执行进度可见，裁决与进度镜像进主人记忆。目标是让拍板队列只进出的积压被持续消化，而主人只处理真正需要人的事项。

## Requirements

### Requirement: 主人可配置委托策略

系统 SHALL 提供委托策略的配置面：cell 级默认 + 舰队级覆写。策略 SHALL 以域（domain）为组织单位，`ops` 域 SHALL 承载既有的舰队内部委托语义：按类别的路由（例行运营、问题单、配置改动、人事、花费 → owner 或 deputy）、可委托的最高严重度、deputy 每日裁决预算、裁决所用模型、汇报摘要频率。`config-change`、人事、花费三类在本域内 SHALL NOT 可配置为委托——它们永远路由 owner。策略变更 SHALL 即时生效于后续路由，SHALL NOT 追溯改写已路由条目。

策略结构 SHALL 允许多域并存，每个域按 `agent-personal-mandate` 的委托状维度声明决策模式、动作范围与知情范围；未声明或未升级的域 SHALL 回落 `advise`，MUST NOT 继承 `ops` 域的路由结论。

存量策略 SHALL 惰性迁移为单一 `ops` 域：读取时兼容扁平旧结构，写入时落多域结构；迁移 SHALL NOT 改变既有路由结果与裁决预算语义。

#### Scenario: 主人把例行运营委托给常务岗

- **WHEN** 主人在设置面把 `ops` 域的「例行运营」类别路由为 deputy 并保存
- **THEN** 此后该类别的新拍板项在创建时即路由 deputy，不再计入主人角标

#### Scenario: 高风险类别不可委托

- **WHEN** 主人尝试把 `ops` 域的「花费」类别路由为 deputy
- **THEN** 设置面拒绝该配置并说明该类别在 `ops` 域永远路由 owner

#### Scenario: 舰队覆写关闭委托

- **WHEN** 某舰队覆写 `ops` 域的 delegation.enabled=false
- **THEN** 该舰队所有新拍板项路由 owner，行为与未启用委托前一致

#### Scenario: 未声明域不继承 ops 路由

- **WHEN** 主人只配置了 `ops` 域，一条属于其他域的事项进入委托判断
- **THEN** 该域按 `advise` 处理，不套用 `ops` 域的 routes 或预算

#### Scenario: 存量策略迁移后语义不变

- **WHEN** 一个使用扁平旧策略 `{routes, maxSeverity, dailyBudget}` 的舰队升级后触发一次裁决
- **THEN** 该配置被读作 `ops` 域并产生与升级前相同的放行或拒绝结果

### Requirement: escalate 时同步路由与归并

岗位 escalate 提交拍板项时，系统 SHALL 按当次生效策略同步设定条目路由（owner 或 deputy）；SHALL 在落库前执行归并检查——同来源岗位、近 N 天（默认 7 天）内语义相似（问题文本相似度或提交方声明的同一主题）的 open 条目存在时，新提交 SHALL 关联到既有条目（计数/时间线更新）而不产生新行，且 SHALL 向提交方返回既有条目引用。归并 SHALL NOT 跨岗位、SHALL NOT 吞掉不同问题。

#### Scenario: 同一阻塞重复升级被归并

- **WHEN** CEO 巡逻第二轮就「重复岗位注册」再次 escalate，而第一轮的相似条目仍 open
- **THEN** 不产生新行，既有条目关联本次升级（升级次数 +1），返回值指回既有条目

#### Scenario: 不同问题不误并

- **WHEN** 同一岗位提交的问题与近 7 天条目均不相似
- **THEN** 正常落新行并按策略路由

### Requirement: 常务岗以受约束工具面裁决

启用委托的舰队 SHALL 可设立常务岗（决策代理岗位）：persona 岗位，自带巡逻节奏，工具面 SHALL 至少含——读取本舰队 route=deputy 的待裁队列、读取来源岗位上下文（近期报数/状态）与主人过往判例、提交裁决（批准选定项/驳回附理由/上报主人附分析）、读写主人记忆。裁决提交 SHALL 经服务端强制授权：条目类别、严重度、当日预算逐项校验，越权 SHALL 以结构化错误拒绝且条目原样保留并转路由 owner；SHALL NOT 仅依赖代理的提示词约束。deputy 上报主人的条目 SHALL 转路由 owner 并携带其分析。

策略路由的每一档 SHALL 都有确定的消费方。除 owner 与 deputy 外的分诊档（`deputy-triage`，用于问题单类：只做归并、跟踪与上报，不产出裁决）SHALL 一并进入常务岗的读取队列，并在每条上标明其处置方式（可裁决 / 仅分诊），使代理不必靠试错分辨。分诊项 SHALL NOT 可被批准或驳回——对它提交裁决 MUST 以结构化错误拒绝并指向「上报主人」这条出口；分诊项 SHALL NOT 计入当日裁决预算。分诊项的唯一处置出口是上报主人，该出口 SHALL 对它开放——它不可裁决，若连上报也被闸掉，这一档就成了一条只能看、不能处置的车道（2026-11-13 实测：本体建设舰队一轮识别出两条分诊项、未硬裁，但两次上报都被拒，只能退回报数，两单原地不动）。

常务岗的三件工具（读队列 / 裁决 / 上报）与审计官结论提交、以及任何按岗授权的上报类动作，SHALL 与 `report_status` 走**同一条身份通道**：岗位坐标由服务端写入成员私有 patch，随请求到达后由工具层原样转发、服务端以 `resolveAttribution` 的第一优先级（自报身份，经三关校验）采纳。委托是逐舰队的，多支舰队的常务节奏可以重叠，因此「此刻只有一个舰队回合在飞」MUST NOT 被当作这些路由成立的前提——**并发是常态，不是异常**。

回服务端的调用 SHALL 收敛到单一出口，使自报身份无法被某条新能力遗漏：工具模块内直呼 HTTP 客户端的行为 SHALL 被守卫拒绝，每个出口调用点 SHALL 传递该次调用的原始参数。

#### Scenario: 预算内裁决生效

- **WHEN** 常务岗在日预算内对一条例行运营项批准选项 X 并附依据
- **THEN** 项转 approved，resolved_by=deputy，依据与引用判例入库，走既有送达管线

#### Scenario: 越出委托被服务端拒绝

- **WHEN** 常务岗尝试裁决一条 config-change 类条目
- **THEN** 服务端以结构化错误拒绝（beyond delegation mandate），条目转路由 owner，常务岗收到拒因

#### Scenario: 判不了向上升级

- **WHEN** 常务岗对某条目无法依判例与策略裁决
- **THEN** 它可将条目转路由 owner 并附分析；项计入主人角标

#### Scenario: 分诊档的条目出现在常务岗队列里

- **WHEN** 某舰队有一条 `route=deputy-triage` 的 open 问题单
- **THEN** 常务岗读取队列 SHALL 看到该条，且该条被标明为「仅分诊」而非可裁决

#### Scenario: 对分诊项提交裁决被拒并指路

- **WHEN** 常务岗对一条 `route=deputy-triage` 的条目提交易或驳回
- **THEN** 服务端 SHALL 以结构化错误拒绝，理由为该条目属分诊档不可裁决，并指向「上报主人」，SHALL NOT 复用「越出委托授权」这类会让人以为是自己越权的话术

#### Scenario: 分诊项可以上报主人

- **WHEN** 常务岗对一条 `route=deputy-triage` 的条目提交「上报主人」并附分析
- **THEN** 该条目 SHALL 转路由 owner、保持 open、附带分析，SHALL NOT 以「只接受 deputy 路由条目」拒绝

#### Scenario: 分诊不消耗裁决预算

- **WHEN** 常务岗分诊并上报了若干条分诊项而未做任何裁决
- **THEN** 当日裁决预算 SHALL NOT 被消耗

#### Scenario: 多支舰队常务岗同时开场仍能读到队列

- **WHEN** 同一 cell 上两个及以上舰队的回合同时在执行，其中一个常务岗调用 `decision_queue`
- **THEN** 该调用 SHALL 按自报身份归属到该常务岗所在舰队并返回其 route=deputy 的待裁项，SHALL NOT 以「多个回合在飞、无法判定归属」拒收

#### Scenario: 未自报身份的调用方仍诚实拒收

- **WHEN** 一个没有岗位坐标（既无中继注入也无 env）的调用方在并发下调用 `decision_queue`
- **THEN** 服务端 SHALL 以结构化错误拒收并把候选岗位写进原因，SHALL NOT 猜测某个舰队把队列交出去

#### Scenario: 新增回服务端能力漏掉身份会被守卫拦下

- **WHEN** 工具模块里出现一处绕过单一出口的直呼，或某个出口调用点未传递本次调用的原始参数
- **THEN** 守卫用例失败并点出该调用点

### Requirement: 裁决携带身份与依据

每条裁决（owner 或 agent）SHALL 记录裁决者身份坐标（成员标识，而非「owner / deputy」二值）、
裁决时所用模型、裁决依据文本及其引用的判例（过往拍板项 id 或记忆条目引用）。主人过往裁决 SHALL
可被代理作为判例读取；独立性成立的代理裁决 SHALL 同样可被读取。拍板队列与管理面 SHALL 展示
裁决者身份与依据，MUST NOT 以「是否由人裁决」作为视觉区分的唯一维度。

判例 SHALL 携带来源等级，等级取值与可引用性见 `agent-decision-independence`：`owner-authored`、
`owner-approved`、`agent-independent`、`agent-independent-unverified` 可被引用；`agent-self`
SHALL NOT 进入判例集，只用于行为一致性统计。等级 SHALL 由服务端按记录的产生路径与独立性图判定，
MUST NOT 采信代理自报，MUST NOT 由记录中出现的主体身份字样决定——代理起草的稿被主人原样发出后
字面上就是主人的口径，不加分级回喂会形成自我强化。

主人裁决的等级 SHALL 由服务端用**自己已持有的事实**判定（该项的推荐值、决议的选择值、以及该次
操作是批准还是驳回），SHALL NOT 依赖调用方必须额外提交一个声明字段：声明字段缺失时服务端 MUST
仍能判出可引用等级。判据为——该条没有推荐值，或主人的选择与推荐不同（驳回即「不采纳推荐」），
SHALL 判 `owner-authored`；主人的选择恰好等于推荐值，SHALL 判 `owner-approved`。调用方显式声明的
来源 SHALL 作为覆盖优先于推导，但缺失声明 MUST NOT 使主人裁决降级为不可引用。

代理裁决 SHALL 记录完整签名链：提案者坐标、裁决者坐标、裁决者模型、验证者坐标与验证者模型、
独立性结论（含每个子条件的成立情况）、裁决依据原文。链上任一坐标缺失时，该裁决 SHALL 落成
`agent-independent-unverified` 或 `agent-self`，MUST NOT 被判为完整独立。

当该裁决经由审计官时，条目 SHALL 附带审计官结论（`同意` / `有异议但放行` / `阻断并上报`）与理由
文本。「阻断并上报」SHALL 由服务端强制生效：条目不进入执行路径、转路由主人并保持 open。审计官结论
与异议文本 SHALL 在其后所有读面（队列、名册、报数）中可见。

#### Scenario: deputy 裁决可审计

- **WHEN** 常务岗批准一条例行运营项
- **THEN** 条目记录 resolved_by=deputy、所用模型、依据文本与引用的判例，队列中可见

#### Scenario: 代理裁决可审计

- **WHEN** 常务岗批准一条例行运营项，提案来自另一岗位
- **THEN** 条目记录裁决者坐标、所用模型、依据文本、提案者坐标与引用的判例，队列中可见

#### Scenario: 判例来自主人历史

- **WHEN** 常务岗面对与主人过往裁决同类的问题
- **THEN** 其裁决依据 SHALL 能引用该过往拍板项（主人当时的选择与理由）

#### Scenario: 代理自裁不入判例

- **WHEN** 检索判例集以支持一次新判断，且候选中含提案者与裁决者同一坐标的记录
- **THEN** 该记录不在结果中；若裁决引用了它，该裁决被拒绝并说明独立性不成立

#### Scenario: 代理独立裁决可作判例

- **WHEN** 检索判例集以支持一次新判断，且一条历史裁决的提案者、裁决者、验证者三者互不相同且验证为盲
- **THEN** 该记录出现在结果中并标注其等级与是否经独立验证

#### Scenario: 调用方不声明来源时主人裁决仍可引用

- **WHEN** 主人从管理面批准一条待裁项，且该请求只携带选择值与备注（未声明来源等级）
- **THEN** 服务端 SHALL 依推荐值与选择值判出 `owner-authored` 或 `owner-approved`，该项 SHALL 进入可引用判例集，SHALL NOT 落成 `agent-self`

#### Scenario: 主人驳回推荐构成独立判断

- **WHEN** 一条待裁项带有推荐值，主人选择驳回
- **THEN** 该裁决 SHALL 判 `owner-authored` 并可被引用（驳回即不采纳推荐，属主人自己的判断）

#### Scenario: 审计官阻断改变终局

- **WHEN** 一条已由常务岗批准的条目被审计官标为「阻断并上报」
- **THEN** 该条目转路由主人并保持 open，不进入执行，理由与代理原判断一并可见

#### Scenario: 异议放行仍留痕

- **WHEN** 审计官给出「有异议但放行」
- **THEN** 动作按原模式执行，异议文本随条目保存并可在后续读面检索
### Requirement: 委托裁决的执行进度可追踪

送达后的条目 SHALL 在送达回合完成时回填执行事实（executed 时刻与会话），其结果 SHALL 可从该回合的报数/会话派生；拍板队列与管理面 SHALL 能回答「批了没执行」与「执行了且结果如何」。deputy 的巡逻回合产出 SHALL 走既有报数管线（管理面可见），其裁决与执行进度 SHALL 镜像进主人记忆 reference 层并按策略频率汇总为摘要。

#### Scenario: 执行事实回填

- **WHEN** 一条已批准项的送达回合完成
- **THEN** 条目回填 executed 时刻与会话，队列中可区分「批了没执行」与「已执行」

#### Scenario: 主人可从记忆查证常务岗作为

- **WHEN** 主人在记忆中查询常务岗近期活动
- **THEN** 可见其裁决摘要（各裁了什么、依据）与跟踪中的问题单状态（最老未决多久）

### Requirement: 角标只计需要主人的事项

应用入口「等你 N 件」角标 SHALL 只计 route=owner 的 open 条目；route=deputy 的条目 SHALL 计入常务岗自己的队列视图。主人 SHALL 可在管理面查看 deputy 队列（含裁决中/已裁决/跟踪中的问题单）。

**所有**展示该角标或等价计数的面 SHALL 采用同一口径（route=owner 的 open 条目），不得各自取全量或取含 deputy 的合计：应用入口徽标、舰队行/总览的未决数、舰队详情页的拍板按钮文案、拍板抽屉标题的计数，以及待办收件箱的徽标（openspec: owner-inbox）。任何一面若无法按该口径计算，SHALL 如实标注不可用，MUST NOT 回退成全量计数。

#### Scenario: 委托后角标下降

- **WHEN** 66 条 open 中 40 条路由 deputy 且尚未裁决
- **THEN** 主人角标计 26（route=owner），deputy 队列视图计 40

#### Scenario: 主人可收回委托

- **WHEN** 主人对一条 route=deputy 的条目选择收回（recall）
- **THEN** 条目转路由 owner 并计入主人角标，deputy 队列移除

#### Scenario: 抽屉标题与徽标同一口径

- **WHEN** 某舰队 26 条 open 路由 owner、40 条路由 deputy，主人打开该舰队的拍板抽屉
- **THEN** 抽屉标题的计数 SHALL 读作 26，与入口徽标一致；deputy 的 40 只出现在常务岗视图

#### Scenario: 计数不可得时不冒充全量

- **WHEN** 某一面无法按 owner 口径计算未决数
- **THEN** 该面标注计数不可用，MUST NOT 显示含 deputy 的全量数字
