# agent-fleet-orchestration Specification

## Purpose

编导代数第一波:舰队以显式 orchestration 声明段描述边(trigger/dispatch/handoff/report)与约束;dispatch 走既有 delegation 车道(异步送达+护栏),handoff 挂回合收口逐跳接棒;mode 预制图读时展开;执行真源仍是任务引擎+delegation 车道,不引入第二调度器。

## Requirements

### Requirement: 舰队以 orchestration 声明段描述编导边与约束

舰队对象 SHALL 支持可选 `orchestration` 段:`edges`(边集)与 `constraints`(spanMax / budgetPerEdgeMin / maxChainDepth,均可缺省取默认)。边 SHALL 为六种之一:`trigger`(cron 触发某岗,= 既有节奏物化的图形态,行为不变)、`report`(报数上行,**由组织树派生**:系统 SHALL 为每个声明了上级的岗位生成一条 `from`=该岗、`to`=其上级的 report 边,读时计算不改运行行为;写面 SHALL 只接受与该树一致的声明并 SHALL 拒绝与之矛盾的声明,读面 SHALL NOT 把同一条边呈现两次)、`dispatch`(运行期由岗位发起的派活许可)、`handoff`(上游岗回合完成后接棒下游岗)、`fanout`(上游岗回合完成后并行扇出至多岗并按聚合式汇流)、`event`(外部信号源唤醒某岗)。每条边 SHALL 显式引用本舰岗位 ref(event 边的 from SHALL 为 `bot:<botId>` 形式的外部信号源名,存在性由运行期如实判定);系统 SHALL NOT 按建队顺序或任何隐式规则推断边。写面 SHALL 全量校验:边引用的岗位存在、handoff 子图无环、每条 handoff 链长 ≤ maxChainDepth、span ≤ spanMax(警告级)。event 边的 to SHALL 为 persona/a2a 岗(cluster 无 manual 车道、tool 的参数是逐跳 args,均结构化拒绝);event 边 SHALL NOT 参与 DAG 环检测。未声明 orchestration 段或声明为 `schedule` 模式时,系统行为 SHALL 与现状逐字节一致。

**编导随模板下发**：orchestration 段 SHALL 可作为 pack 舰队模板的组成部分下发——发布预校验与实例化建队 SHALL 复用与写面同一校验器（以模板成员集为岗位域）；由模板落地的编导与手写编导在运行时 SHALL 无差异，主人的后续改写走既有写面。模板编导不改变本条的任何护栏语义。

#### Scenario: 声明一条流水线

- **WHEN** 舰队声明 handoff 边 抓取→清洗→撰稿 与 trigger 边 cron(0 9 * * *)→抓取
- **THEN** 校验通过,三岗节奏物化照常(清洗/撰稿无节奏物化),每日 9 点抓取回合完成后自动接棒清洗

#### Scenario: 隐式推断被拒

- **WHEN** 声明段留空但期望按建队顺序成链
- **THEN** 不产生任何 handoff 行为;边只有显式声明一种来源

#### Scenario: 环拒绝

- **WHEN** handoff 边构成 A→B→A
- **THEN** 写面结构化拒绝并指名成环边

#### Scenario: 未声明逐字节等价

- **WHEN** 一支未声明 orchestration 的既有舰队在本 change 后运行
- **THEN** 节奏物化、报数、拍板、模型归位、事件流与现状逐字节一致(既有测试套件为等价证明)

#### Scenario: fanout 边校验

- **WHEN** 声明 fanout 边 targets 只有一个岗,或 targets 含 from 自身,或 judge 引用 targets 成员,或 rounds 为 5,或 targets 含 tool 岗
- **THEN** 写面结构化拒绝并逐项指名

#### Scenario: event 边校验

- **WHEN** 声明 event 边 from="bot:helper" to=客服岗(persona),或 to 为 cluster/tool 岗,或 from 非 bot: 形式
- **THEN** 前者通过;后两者结构化拒绝并指名原因

#### Scenario: 模板编导与手写无差异

- **WHEN** 两支结构相同的舰队，一支的 orchestration 来自模板下发、一支由主人手写
- **THEN** 二者的边展开、派发许可、接棒与唤醒行为完全一致

#### Scenario: 报数边随组织树出现

- **WHEN** 舰队有岗位 A 与直属下级 B,且未声明任何 report 边
- **THEN** 编导读面出现一条 `from=B, to=A` 的 report 边(标注为派生),SHALL NOT 要求主人手写

#### Scenario: 与树矛盾的报数声明被拒

- **WHEN** B 的直属上级是 A,而声明段写了 `report: B→C`
- **THEN** 写面结构化拒绝并指名"B 报给 A,不是 C",SHALL NOT 落库

#### Scenario: 一致声明不重复呈现

- **WHEN** 声明段已写 `report: B→A` 且 B 的上级确实是 A
- **THEN** 校验通过,读面上这条边只出现一次(保留声明形态,不再叠一条派生边)

### Requirement: dispatch 边使能同舰队岗位间派活

持有 dispatch 许可(显式 dispatch 边、supervisor 模式展开、或**声明 handoff 边的成对双向授权**)的岗位回合 SHALL 获得 `dispatch_post` 工具:按岗位 ref 派活给同舰队岗位,brief 为自包含任务说明;派发 SHALL 走既有 delegation 车道创建 manual 任务(证据 `origin.fleet` 指名目标岗、initiator 为**派发岗本回合的会话**)。initiator SHALL 取自派发归因判定出的调用来源——在飞回合用该回合的镜像会话、运行中的舰队任务用该任务的会话、聊天车道才用当前会话指针;系统 SHALL NOT 一律取运行时的全局会话指针。派发任务 SHALL 另记录派发岗的人格,使回执汇总以派发岗的口吻起回合;每次派发 SHALL 携带独立的聚合分组键,同一派发岗的多次派发 SHALL NOT 并成一次汇总。,结果 SHALL 异步送达——派发立即返回,目标岗回合摘要经聚合器在派发岗下一回合注入,系统 SHALL NOT 挂起派发回合等待。护栏 SHALL 结构化拒绝:跨舰队目标、自派、目标岗回合深度已达 1、每岗每回合派发超上限(默认 3)、舰队每小时派发超上限(默认 30,均可 env 配置)。派发目标域 SHALL 为 persona、a2a 与 tool 岗(cluster 岗无 manual 车道,SHALL 结构化拒绝)。派发与被派发回合 SHALL 经既有回合收口自动产出 O1 事件,不新增记录路径。**成对双向授权**：舰队编排声明了 handoff 边的两岗之间,dispatch 许可双向成立——上游→下游为移交、下游→上游为退回;该许可只作用于该边的两端点之间,系统 SHALL NOT 借此扩展到任何其他岗位对;许可为读时判定,系统 SHALL NOT 派生落盘的隐式边。

#### Scenario: 主管派活闭环

- **WHEN** supervisor 模式下主管岗回合内 dispatch_post(执行岗 ref, brief)
- **THEN** 执行岗起 manual 回合,brief 含派发者身份;派发岗本回合继续收尾,下回合收到执行岗回合摘要

#### Scenario: 护栏拒绝面

- **WHEN** 派发目标在另一舰队、或目标为本岗、或目标回合深度已 1、或超频次上限
- **THEN** 工具以结构化错误拒绝并指明原因,不创建任务

#### Scenario: handoff 正向移交

- **WHEN** 舰队声明 handoff 边 建模岗→校验岗,建模岗回合内 dispatch_post(校验岗 ref, brief)
- **THEN** 许可成立,校验岗起 manual 回合——建模岗无需另声明 dispatch 边

#### Scenario: handoff 反向退回

- **WHEN** 同上舰队,校验岗回合内 dispatch_post(建模岗 ref, 拦截件退回 brief)
- **THEN** 许可成立(同一声明边的反向),建模岗起 manual 回合收到拦截件

#### Scenario: 未声明对仍拒

- **WHEN** 舰队仅声明 handoff 边 盘账→建模,建模岗 dispatch_post(无关的第三岗 ref)
- **THEN** 结构化拒绝:成对授权只覆盖声明边的两端点

#### Scenario: 定时车道的派发回执回到派发岗

- **WHEN** 定时触发的派发岗回合在运行中调用 dispatch_post,而此时运行时的全局会话指针指向别处
- **THEN** 新建任务的 initiator 为该回合的镜像会话(不是全局指针),回执汇总在该派发岗的会话里起回合

#### Scenario: 聊天车道零变化

- **WHEN** 用户在聊天里以某 persona 身份调用派发
- **THEN** initiator 仍为该聊天会话,派发任务的人格为该聊天当前人格

### Requirement: handoff 边在上游回合完成后接棒下游

上游岗回合结束(成功或失败均如实)时,系统 SHALL 在回合收口处检查该岗出边:每条 handoff 边 SHALL 为下游岗创建 manual 回合(persona、a2a 与 tool 岗可达;cluster 岗无 manual 车道,跳过),证据 `origin.fleet` 指名下游岗,深度按链位递增且不超过声明链长,每跳时长上限取 budgetPerEdgeMin;整链 SHALL 逐跳产出 O1 事件,链上各跳花费合计记入发起回合的证据链。上游失败时下游 SHALL 照常接棒并收到失败上下文(如实转述,不自动重试)。

上游回合 SHALL 把其**产出的可寻址产物句柄**随边下传：系统 SHALL 在点火时读取上游回合产出的资源库条目
（以该回合的会话与起止窗口界定，取最近若干条），并在下游 prompt 中 SHALL 以「资源库标识 + workspace 相对路径」
的形式列出，且 SHALL 明确指示下游直接取用而不要重新生成。产物段 SHALL 排在既有散文转述之后、
上下文占位符之前；上游未产出任何产物、或资源库不可读时，SHALL 整段缺席且 prompt 其余部分逐字节不变
（降级放行，绝不因产物读取失败而阻断接棒）。产物句柄 SHALL 仅下发给 persona 目标：a2a 目标是另一服务
（资源库标识对其无意义），tool 目标的 prompt 必为纯 JSON 参数。

#### Scenario: 链式接棒

- **WHEN** 抓取岗回合成功结束且有 handoff 边至清洗岗
- **THEN** 清洗岗自动起回合,brief 含上游产出引用与链位;两跳各产一条 O1 事件

#### Scenario: 上游失败如实接棒

- **WHEN** 抓取岗回合失败(errorKind=model_upstream)
- **THEN** 清洗岗照常接棒,brief 含上游失败摘要;不重试、不吞错

#### Scenario: 链深守界

- **WHEN** 递增后的链位将超过声明 maxChainDepth
- **THEN** 不创建下游回合,以结构化事件记录越界拒绝

#### Scenario: 接棒拿到上游产物句柄

- **WHEN** 上游回合产出了「季度图表.json」（资源库条目 + workspace 路径），其 handoff 边点火 persona 下游
- **THEN** 下游 prompt 含「上游产物」段，列出该条目的资源库标识与 workspace 相对路径，并指示直接取用
- **AND** 散文转述仍在产物段之前，上下文占位符仍在最后

#### Scenario: 上游无产物则零变化

- **WHEN** 上游回合没有产出任何资源库条目
- **THEN** 下游 prompt 不含产物段，与引入本条款前逐字节一致

#### Scenario: 只给 persona

- **WHEN** 同一波上游产物下发到 a2a 目标或 tool 目标
- **THEN** a2a 的 prompt 不含产物段；tool 的 prompt 仍是纯 JSON 参数

#### Scenario: 扇出每个 persona 目标都拿到

- **WHEN** 扇出波有多个 persona 目标
- **THEN** 每个目标的 prompt 都含同一份产物段

#### Scenario: 资源库不可读不阻断

- **WHEN** 资源库未就绪或读取抛错
- **THEN** 产物段缺席，接棒照常点火，SHALL NOT 因此失败

### Requirement: fanout 边以并行波执行且有界轮次成环

上游岗回合结束后,系统 SHALL 对其每条 fanout 出边执行一个并行波:为每个目标岗创建 manual 回合(深度按链位递增受 maxChainDepth 硬界,brief 含上游产出或失败的如实转述与轮次标注,与 handoff 同式;深度超界时 SHALL 不建任务并落结构化 O1 事件如实留痕)。聚合 SHALL 二式分流:无 judge 时,波内任务的 initiator SHALL 为上游回合会话——delegation 聚合器在全部终态后把全组结果注入上游岗的下一回合;声明 judge 时,initiator SHALL 为 `fleet:<舰队标识>:<judge 岗位标识>` 且 initiatorPreset 为 judge 岗 persona——聚合器 SHALL 自动以裁决者身份起一回合,其输入为全组目标产出。多轮辩论 SHALL 由裁决者在裁决回合内显式派发下一波(既有派发许可与护栏,深度界为硬防线);边的 rounds 声明 SHALL 为草稿呈现层的上界提示,系统 SHALL NOT 依其自动重入。

无论是否声明 judge,波内任务 SHALL 携带本波的聚合分组键(一条出边一次点火一个键,同波共用),使聚合以波为单位而非以会话为单位;无 judge 时波内任务 SHALL 另携带 initiatorPreset 为上游回合实际所用的人格,以裁决者身份起汇总回合的判据不因此变化。`origin.fleet.wave` SHALL 继续只作溯源标注,SHALL NOT 作为聚合分组键。

#### Scenario: 并行波与默认聚合

- **WHEN** 主编岗回合结束,有 fanout 边 targets=[撰稿A,撰稿B] aggregate=all
- **THEN** 两 manual 回合并行创建;两回合全部终态后,聚合器把两份产出注入主编会话的下一回合

#### Scenario: 裁决回合

- **WHEN** 同上但 aggregate={kind:"judge", judge:评审岗}
- **THEN** 波内任务 initiator 指向评审岗;全组终态后评审岗自动起回合,brief 含两份产出摘要

#### Scenario: 深度界拒绝波

- **WHEN** 链位递增后超过舰队声明 maxChainDepth 的扇出目标
- **THEN** 该目标不建任务,落 O1 事件留痕拒绝

#### Scenario: 多轮辩论为显式派发

- **WHEN** 裁决回合认为需要第二轮且舰队声明了相应派发许可
- **THEN** 第二波由裁决岗 dispatch_post 显式发起,护栏与深度界照常生效;系统不依 rounds 自动重入

#### Scenario: 上游失败如实入波

- **WHEN** 上游回合失败,fanout 出边照常触发
- **THEN** 波内 brief 含失败转述,不重试不吞错

#### Scenario: 每波一个分组键

- **WHEN** 同一条 fanout 边先后点火两次
- **THEN** 两次创建的波内任务各自带一个分组键,两次的分组键不同,同一次波内所有任务共用同一个键

#### Scenario: 无 judge 波带发起人格

- **WHEN** fanout 边未声明 judge,上游回合在 persona X 下运行
- **THEN** 波内任务的 initiatorPreset 为 X,聚合器据此把上游会话摆回 X 再起汇总回合

### Requirement: bot 入站消息唤醒绑定的岗位

社聊 bot 的入站消息在既有守卫(尺寸/频次)全部通过后,系统 SHALL 额外扫描舰队的 event 边:存在 `from:"bot:<该 bot>"` 的边时,SHALL 为每条边的 to 岗位创建 manual 回合——brief 含发送者与消息原文、`origin.fleet {memberId, depth:0}` 与 `origin.event {botId, chatKey}`,该回合 SHALL 经既有收口产出 source=event 的 O1 事件。

同一信号源在同一会话内的**连发消息 SHALL 合并为一次唤醒**：系统 SHALL 以（信号源，会话）为键、在短窗口内缓冲入站消息，窗口关闭时以**合并后的对话**创建至多一个回合，SHALL NOT 为每条消息各起一回合。窗口长度 SHALL 可配置，且 SHALL 支持取 0 以恢复逐条唤醒的旧语义；窗口未关闭前 SHALL NOT 创建任务。合并 SHALL 如实：合并回合 SHALL 记录其承载的消息条数，正文超长 SHALL 截断并留可见标记，被略去的早期消息 SHALL 在正文中显式说明条数，SHALL NOT 静默丢弃；发言人 SHALL 取最后一位发言人，「被点名」判据 SHALL 为任一条消息命中。不同会话的消息 SHALL NOT 合并。bot 自身的会话回合 SHALL 照常执行(bot 答聊天,岗位异步做舰队事)。护栏:每岗每小时唤醒次数 SHALL 有上限(默认 30,环境可配),超限 SHALL 不建任务并落结构化 O1 事件如实留痕。无命中边的入站消息 SHALL 零扰动。

#### Scenario: 命中唤醒

- **WHEN** 客服 bot 收到一条消息,且某舰队声明了 event 边 bot:客服bot→客服岗
- **THEN** 客服岗起 manual 回合(prompt 含消息原文与发送者),O1 事件 source=event;bot 照常回答聊天

#### Scenario: 护栏超限

- **WHEN** 一小时内该岗被唤醒已达上限又来一条命中消息
- **THEN** 不建任务,落 O1 事件留痕拒绝

#### Scenario: 无命中零扰

- **WHEN** 一条入站消息没有任何 event 边引用该 bot
- **THEN** 不产生任何舰队任务与事件,bot 行为与现状逐字节一致

#### Scenario: 连发消息只唤醒一次

- **WHEN** 同一 bot 在同一会话内于窗口内连发三条消息
- **THEN** 窗口关闭后只创建一个回合，其正文含三条消息内容，且记录承载消息数为 3

#### Scenario: 不同会话不合并

- **WHEN** 同一 bot 在两个不同会话各发一条
- **THEN** 各创建一个回合，互不包含对方内容

#### Scenario: 关闭窗口恢复逐条唤醒

- **WHEN** 窗口配置为 0
- **THEN** 每条消息立即各创建一个回合（与引入本条款前逐字节一致），且不记录承载条数

#### Scenario: 合并正文超长留标记

- **WHEN** 合并后的正文超过既有长度上限
- **THEN** 正文被截断并带可见截断标记，回合仍创建，SHALL NOT 因超长而丢消息

### Requirement: 边点火按回合幂等

系统 SHALL 以「上游回合身份 + 边种类 + 目标岗位」为键，使同一回合的边点火至多生效一次：同一回合重复进入点火（重试执行、重复收口回调、恢复后的同一轮）SHALL NOT 再创建下游任务，SHALL NOT 追加第二波。上游回合身份 SHALL 取运行账本的回合标识；账本缺席时 SHALL 取引擎的每次执行序号，使同一次执行的重复进入仍被去重。

每次点火创建的每个 hop SHALL 把该键写入任务溯源，使幂等判定无需新增存储、且跨重启仍成立（判定读的是已落库的任务本身）。键 SHALL NOT 以岗位为单位——不同回合（例如运维刻意重跑某岗、或下一轮节奏触发）SHALL 各自点火，否则链条无法被重新驱动。

#### Scenario: 同一回合重复进入只点火一次

- **WHEN** 某上游回合收口后点火一次，随后同一回合再次进入点火（重试或重复回调）
- **THEN** 第二次不创建任何下游任务，也不追加第二波；已创建任务的溯源里带着该次点火的键

#### Scenario: 新回合照常点火

- **WHEN** 同一上游岗位在另一个回合（新回合标识）收口
- **THEN** 其声明边照常点火，下游任务各带新回合的键

#### Scenario: 无账本仍按执行去重

- **WHEN** 部署未启用运行账本，同一执行序号下重复进入点火
- **THEN** 仍只点火一次；下一次执行（序号递增）照常点火

#### Scenario: 溯源可读

- **WHEN** 检查任一由边点火创建的任务
- **THEN** 其溯源中可读到「回合:边种类:目标岗」形态的点火键，可用于定位重复来源

### Requirement: 整 run 预算与停车闸

舰队编排 SHALL 可声明整 run 预算 `constraints.runBudget`，含三个互相独立、均可选的维度：`maxTurns`（本 run 允许起的回合数）、`maxTokens`（本 run 累计上报 token 的上限）、`maxMinutes`（自 run 头行开始时刻起的墙钟上限）。未声明 SHALL 表示无上限，行为与引入本条款前一致。写面 SHALL 以结构化错误拒绝非对象、含未知维度、含非正数、或声明了却没有任何有效上限的 `runBudget`；SHALL NOT 把畸形声明静默当作「无上限」。

预算 SHALL 在**边点火**处执行：起火前 SHALL 读取 run 头行与该 run 的回合事实（终态回合取自回合行，另加本 run 仍在排队/执行中的任务），任一维度达上限 SHALL NOT 创建任何下游任务，SHALL 把该上限作为本 run 的停车原因落库，并 SHALL 落一条结构化事实行说明「点火被拒」及其原因；SHALL NOT 静默不点火。

系统 SHALL 提供 run 级停车入口（`POST /:id/runs/:runId/cancel`，仅舰队主人）：SHALL 在 run 头行记录停车时刻与原因，SHALL 中止该 run 在飞回合（经既有中止注册表，落为 interrupted 而非 failed），并 SHALL 使该 run 的一切后续点火被拒。停车 SHALL 幂等——重复调用 SHALL 保留首次原因，SHALL NOT 重复中止。run 收口（status/计数重算）SHALL NOT 清除停车事实。

`constraints.spanMax` SHALL 维持既有 advisory 语义（只告警，不阻断），本条款不改其性质。

#### Scenario: 回合数上限拦下下游

- **WHEN** 某 run 已声明 `maxTurns: 1`，其根回合已执行完毕并触发一条 handoff 边
- **THEN** 该边不创建任务；run 头行的停车原因记录为预算触顶；另有一条事实行说明点火被拒及原因

#### Scenario: 三个维度互相独立

- **WHEN** 某 run 已声明 `maxTokens` 但其回合数与墙钟都远未到上限
- **THEN** 一旦累计 token 达上限即拦下点火；反之 token 未超而回合数超上限时也拦下

#### Scenario: 未声明零变化

- **WHEN** 舰队未声明 `runBudget`
- **THEN** 点火行为与引入本条款前逐字节一致（不新增拦截、不新增事实行）

#### Scenario: 主人取消 run

- **WHEN** 舰队主人对某在飞 run 调用 cancel
- **THEN** 头行记下停车时刻与原因、该 run 在飞回合被中止（落 interrupted）、该 run 后续点火全部被拒

#### Scenario: 取消幂等且不重复中止

- **WHEN** 对同一 run 再次调用 cancel（即使带了不同原因）
- **THEN** 保留首次原因，不再中止第二次，响应如实标注「此前已停车」

#### Scenario: 停车事实不被收口抹掉

- **WHEN** 已停车的 run 随后完成收口重算
- **THEN** 头行的 status/turns 等派生值照常更新，停车时刻与原因保持原值

#### Scenario: 畸形预算拒绝

- **WHEN** 编排声明 `runBudget: 5`、或 `runBudget: {}`、或含未知维度
- **THEN** 写面以结构化错误拒绝并指名问题，声明不落库

#### Scenario: 越权与未知 run

- **WHEN** 非主人或未知 run 调用 cancel
- **THEN** 以与「不存在」一致的方式拒绝，不泄漏他舰队内容
