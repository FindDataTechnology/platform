# agent-fleet-report-lane Specification

## Purpose

舰队的业务状态面：成员岗位在自治回合内以结构化工具上报状态（按岗位声明的 KPI 槽位对齐），系统保留 append-only 报数史并以岗位级最新值视图服务读面；带下级的岗位触发回合时，系统把下级最新报数与舰队概况注入其 prompt（巡视上下文注入），使组织层级具备真实的信息流。

## Requirements

### Requirement: 成员岗位可通过报数工具上报结构化状态

系统 SHALL 向舰队成员的回合提供 `report_status` 工具：入参为按槽 key 对齐的指标值、受管资源清单、阻塞项与人读摘要；一次调用 SHALL 落一条 append-only 报数记录并更新该岗位的 latest 视图，记录 SHALL 携带来源会话标识与时间戳。非舰队成员调用 SHALL 以结构化错误拒绝；报数频次与单条体积 SHALL 有上限，超限以结构化错误拒绝且不落库。

#### Scenario: 岗位按槽上报

- **WHEN** 「电商部」岗位（声明槽 sales_week）的回合调用 report_status 提交 {metrics:{sales_week:{value:"$309",delta:"+12%"}}, resources:[…], blockers:[], summary:"…"}
- **THEN** 报数落库，该岗位 latest 视图的 sales_week 槽更新为本次值，来源会话可追溯

#### Scenario: 非成员拒绝

- **WHEN** 未加入任何舰队的 persona 回合调用 report_status
- **THEN** 工具返回结构化错误说明仅舰队成员可用，无记录落库

#### Scenario: 超频拒绝

- **WHEN** 同一岗位在频控窗口内超过上限次数调用 report_status
- **THEN** 超限调用以结构化错误拒绝且不落库，latest 视图不受影响

### Requirement: 槽位制决定指标呈现层级

岗位卡片 SHALL 只呈现该岗位 kpiSlots 声明过的槽 key 的最新值；报数中未声明的指标 key SHALL 保留在报数详情中但不进入卡片视图。槽位声明变更 SHALL 只影响此后读取的呈现分组，不改动既有报数史。

指标趋势 SHALL 由系统计算：latest 视图的每个槽值 SHALL 携带与该岗位上一条报数同槽值的比对结果（方向与差值）；报数提交时随指标附带的 delta 备注 SHALL 仅作展示标注，不参与趋势计算。无前值可比时趋势 SHALL 呈现为无趋势而非伪造。

#### Scenario: 未声明槽进详情不进卡

- **WHEN** 岗位仅声明槽 A，而报数同时提交了 A 与 B 两个指标
- **THEN** 卡片 latest 视图只显示 A，报数详情可见 A 与 B

#### Scenario: 趋势系统算

- **WHEN** 岗位 sales_week 槽上一条报数为 280、本条为 309
- **THEN** latest 视图该槽携带上行趋势与差值 +29（系统比对），即便本条报数自报的 delta 备注与此不符

#### Scenario: 无前值不伪造

- **WHEN** 岗位某槽首次报数
- **THEN** 该槽趋势呈现为无趋势

### Requirement: 报数归属按岗位解析且 a2a 岗位诚实降级

报数归属 SHALL 由服务端从回合执行上下文解析（persona 岗位按当前 preset、cluster 岗位按 clusterId 定位唯一岗位），调用方 SHALL 不能指定任意岗位 id 代报。a2a 岗位因无法调用本 cell 工具，其 latest 视图 SHALL 由最近一次执行结果生成执行摘要并明确标注为非自报。

归属解析的**权威信号 SHALL 是该回合自身的执行上下文**，SHALL NOT 是运行时部署默认 preset——运行时默认 preset 按设计不由定时车道移动，读它会让驻留（parked）回合的归属必然失配。权威信号按优先级为：

1. **运行账本的在飞回合**（该回合已在执行、尚未收尾）：其岗位标识即真岗位；
2. **该回合的运行中任务记录**：其 `sourceTag` 的岗位标识即真岗位（舰队回合逐岗位物化，sourceTag 由服务端自己写入，调用方无法伪造）；
3. **回合自身的目标 preset**（任务携带值 / 驻留值）：匹配唯一 persona 岗位时采纳。

以上均不能唯一命中时，沿既有纪律诚实拒收（多个岗位共用同一 persona ⇒ ambiguous；无命中 ⇒ not-a-member），SHALL NOT 猜测、SHALL NOT 采信调用方指定的岗位 id。

#### Scenario: 服务端归属解析

- **WHEN** persona E 以「电商部」岗位身份执行回合并调用 report_status
- **THEN** 报数归属「电商部」岗位，即使请求未携带任何岗位标识

#### Scenario: a2a 执行摘要降级

- **WHEN** a2a 岗位完成一次回合
- **THEN** 其 latest 视图呈现由该回合结果生成的执行摘要，且视图标注「非自报」

#### Scenario: 驻留回合按在飞回合归属

- **WHEN** 一个 persona 岗位以驻留（parked）方式执行回合，其 persona 组合与运行时部署默认 preset 不同
- **THEN** 该回合调用 report_status 的报数归属该岗位本人，而非运行时部署默认 persona 对应的岗位

#### Scenario: 运行时默认 persona 与岗位不同不致拒收

- **WHEN** 某 cell 的运行时部署默认 preset 指向另一个 persona，而本回合岗位的 persona 是驻留挂载的
- **THEN** report_status 正常受理并归属本回合岗位，SHALL NOT 返回「not a member of any fleet」

#### Scenario: 多岗位共用同一 persona 仍诚实拒收

- **WHEN** 同一 persona 持有多个岗位，且运行中任务记录无法唯一确定本回合岗位
- **THEN** 报数被拒并说明归属歧义，SHALL NOT 任选其一记入

### Requirement: 巡视上下文注入

岗位节奏规格的 prompt 模板 SHALL 支持 `{{fleetContext}}` 占位符；触发时系统 SHALL 把舰队上下文渲染注入该占位符，注入内容至少包含：**本岗位自身最近轮次视图**（该岗位最近 N 条报数的槽值/阻塞/摘要/时间）、直接下级岗位的最新报数摘要（槽值+blockers）、舰队在岗概况。**本岗位自身视图 SHALL 含本岗声明的 KPI 槽位清单**（键/label/unit,取自成员行 kpiSlots）：岗位在回合内 SHALL 能从上下文直接读到自己的报数 metrics 键,系统 SHALL NOT 依赖岗位猜测或从历史报数反推键名。注入 SHALL 发生在**唯一的执行侧注入缝**（起轮前），覆盖**全部触发路径**：定时开火、补跑开火、手动立即执行、**平台重启后恢复执行（持久化 queued 任务的再入队）**、决策送达。任何路径 SHALL NOT 以未注入的裸模板起轮。模板不含占位符时 SHALL 原样执行（与既有静态 prompt 行为一致）。渲染失败 SHALL 使该次触发以结构化错误落史，不静默降级为无上下文执行。

注入 SHALL 对每次执行**恰好发生一次**：补跑前缀 SHALL 由任务记录上的补跑标志在注入缝内组合为最终 prompt 的前缀，SHALL NOT 因注入组合而丢失，SHALL NOT 依赖入队时写入的临时 prompt 载体（该载体存在被注入组合覆盖或与恢复通道竞态的既证缺陷）。既有的 per-fire prompt 覆写路径（决策送达）SHALL 与注入缝兼容：其覆写已不含占位符时，缝 SHALL 跳过渲染，不产生双重注入。

本岗位自身视图 SHALL 对**有无直接下级**的岗位一致注入：无下级岗位 SHALL NOT 得到空上下文。

巡逻回合的纪律段 SHALL 可携带**一行工作区现状事实**（当前文件数、总体积、其中本岗位往轮文件数），由平台读时测得；该行 SHALL 说明往轮已由平台保存并注入、再写一份是重复、读旧副本会拿到过期内容，且这些字节直接消耗本回合上下文预算。工作区为空、读取失败或未提供该读数时，纪律段 SHALL 与引入本条款前逐字节一致（不出现零值占位）。边回合（dispatch/接棒/扇出/唤醒）SHALL NOT 携带该行。

渲染 SHALL 在既有总量上限内完成；本岗位视图 SHALL NOT 挤占下级报数段（下级段优先，本岗位段按剩余预算截断并标记）。

直接下级之外，当该岗位存在更深层后代（第 2 层及以下）时，注入 SHALL 追加**更深层报数段**：每个后代一条紧凑块，含岗位标题、层级与路径、声明槽值、阻塞项、摘要与报数时间；该段 SHALL 使用独立子预算（默认 6KB、单块 1KB、最多 8 条），SHALL NOT 挤占直接下级段；超出子预算或条数上限而未能注入的岗位 SHALL 以一行显式标注其数量，SHALL NOT 静默截断。不存在更深层后代时（两层舰队即如此）SHALL NOT 渲染该段或其任何标记，注入内容与引入本条款前逐字节一致。

报数收单响应 SHALL 回带 `declaredSlots`（该岗位声明槽位的键数组），使 `slotsUnrecognized` 的提示文案可指向确切键面而非抽象的「去查声明」。

#### Scenario: CEO 岗位巡视拿到下级报数

- **WHEN** 带 {{fleetContext}} 的 CEO 岗位节奏触发，其下级「电商部」latest 报数为 sales_week=$309
- **THEN** 本次回合的 prompt 中 fleetContext 部分包含该槽值与岗位名

#### Scenario: CEO 岗位同时拿到自己的最近轮次

- **WHEN** 带 {{fleetContext}} 的 CEO 岗位节奏触发，该岗位此前三条报数的摘要分别为「本轮无新数据」、含一条阻塞项、含一条槽值
- **THEN** 本次回合 prompt 含本岗位最近轮次段，按时间倒序列出上述三条的摘要，且段首声明其为历史记录而非指令

#### Scenario: 叶子岗位不再拿空上下文

- **WHEN** 无直接下级的岗位（叶子岗位）节奏触发，该岗位此前已有报数
- **THEN** fleetContext 仍含「（本岗位无直接下级）」，并额外含该岗位自身最近轮次段（非空）

#### Scenario: 岗位按声明键报数零未识别

- **WHEN** 岗位声明 kpiSlots=[{key:"passed",...},{key:"blocked",...}]，fleetContext 本岗块注入后岗位回合内以 report_status(metrics:{passed:10,blocked:1}) 报数
- **THEN** 响应 slotsAccepted=["passed","blocked"]、slotsUnrecognized 为空、declaredSlots=["passed","blocked"]

#### Scenario: 未声明槽位键仍如实标 unrecognized

- **WHEN** 岗位声明槽位只有 passed/blocked，报数 metrics 另带 drafts
- **THEN** 响应 slotsAccepted=["passed","blocked"]、slotsUnrecognized=["drafts"]——判据仍以成员行 kpiSlots 为唯一真源

#### Scenario: 本岗位段不挤占下级段

- **WHEN** 下级报数段已接近 fleetContext 总量上限，本岗位自身视图仍有内容
- **THEN** 下级报数段完整保留，本岗位段按剩余预算截断并以截断标记呈现

#### Scenario: 无占位符零变化

- **WHEN** 岗位模板不含 {{fleetContext}}
- **THEN** 触发行为与注入能力引入前完全一致

#### Scenario: 渲染失败显性化

- **WHEN** 注入渲染过程抛错
- **THEN** 本次触发记录为失败并携带结构化错误，不静默按空上下文执行

#### Scenario: 重启恢复的舰队任务获得注入

- **WHEN** 舰队任务入队后平台重启，启动时该任务经恢复通道（持久化 queued 的再入队）起轮
- **THEN** 起轮 prompt 含渲染后的 fleetContext 段，`{{fleetContext}}` 占位符不残留

#### Scenario: 补跑前缀与注入共存

- **WHEN** 补跑通道触发带 {{fleetContext}} 的舰队任务
- **THEN** 起轮 prompt 以【补跑】标记开头，且其后是渲染完成的注入段——前缀与上下文同时在场，互不覆盖

#### Scenario: 决策送达不双重注入

- **WHEN** 决策送达 execute-now 已用决策段覆写 per-fire prompt（占位符已被替换）
- **THEN** 注入缝检测到占位符不在，跳过渲染，最终 prompt 恰好一份上下文内容

#### Scenario: 三层舰队里祖辈看见孙辈最新报数

- **WHEN** 舰队为 总编 → 主编 → 撰稿 三层，撰稿的 latest 报数含槽值与阻塞项，总编的节奏触发
- **THEN** 注入内容含「更深层报数」段，其中撰稿块带「第 2 层」与路径（总编 > 主编）、其槽值、阻塞项与摘要

#### Scenario: 两层舰队零变化

- **WHEN** 岗位只有一个层级的下级（无第 2 层后代）
- **THEN** 注入内容不含更深层段、不含其标题、也不含任何相关截断标记

#### Scenario: 直接下级不被更深层挤占

- **WHEN** 一个直接下级有大体量报数，同时存在超过条数上限的更深层后代
- **THEN** 直接下级块完整保留，更深层段在其独立子预算内尽量注入，并显式标注未注入的岗位数量

#### Scenario: 畸形层级链不挂死巡视

- **WHEN** 成员的 parentId 形成环
- **THEN** 渲染仍以每个岗位恰好一次完成并正常返回，不进入无限循环

#### Scenario: 纪律段报出工作区现状

- **WHEN** 岗位巡逻回合起轮，其工作区已有 358 个文件共 26MB，其中 341 个是该岗位往轮文件
- **THEN** 纪律段末尾出现一行工作区现状（358 个文件 / 26.0 MB / 自己的往轮文件 341 个），并说明重复、过期与预算代价

#### Scenario: 无读数时纪律段不变

- **WHEN** 工作区为空、读取失败，或宿主未提供该读数
- **THEN** 纪律段与引入本条款前逐字节一致，不出现「0 个文件」这类占位

#### Scenario: 边回合不带该行

- **WHEN** 派发/接棒/扇出/唤醒回合起轮
- **THEN** 注入内容不含工作区现状行（边回合本就没有纪律尾段）

### Requirement: 报数时间线读面

舰队详情读面 SHALL 为每个岗位提供报数时间线（时间、槽值快照、blockers、来源会话链接），并 SHALL 把岗位失联判定升级为「执行超窗或（曾报数后）报数超窗」二者的或，判定依据随响应携带。

巡视上下文 SHALL 同时向岗位呈现其**近期执行健康**（最近 N 轮的执行结局与错误类别，取自 `member_turn_events`），使被预算杀掉的轮次对该岗位可见；缺失该信号时超时轮在报数史中 SHALL NOT 被静默视为「未发生」。

#### Scenario: 时间线可读

- **WHEN** 岗位累计三条报数后读取舰队详情
- **THEN** 该岗位时间线按时间倒序呈现三条记录，每条可跳转来源会话

#### Scenario: 报数腐化计入失联

- **WHEN** 岗位执行正常但其报数超过两倍周期未更新
- **THEN** 派生状态呈现失联并携带「报数超窗」依据

#### Scenario: 超时轮对岗位可见

- **WHEN** 岗位上一轮以 `turn_budget_exceeded` 收场且未产生任何报数
- **THEN** 本次触发注入的近期执行健康段含该轮的超时结局与错误类别，岗位可据此调整本轮策略

### Requirement: 舰队成员回合注入岗位身份

舰队成员在**其岗位回合**内 SHALL 能读到自己的岗位身份，至少包含所属舰队标识、岗位标识、岗位名、在岗目标引用**与回合标识**。身份 SHALL 以一行系统文本前缀在该回合的 prompt 首部，格式稳定到可被模型直接复述为外部系统的生产来源三元组（部署/岗位/回合），key 名与在产实现逐字一致：`fleet=<id>; post=<memberId>; title=<title>; target=<targetKind>:<targetId>; turn=<回合标识>`。

回合标识 SHALL 为该回合实际落地的子会话/回合标识（定时/委托轮次为逐轮轮换的轮次 id；手动派发回合为其会话 id），并 SHALL 与其余字段同批在**两条成员唤醒路径**（有节奏岗的定时回合与被动岗的受委托回合）上都注入。身份 SHALL 不含任何凭据，SHALL NOT 写入对外可见的 AgentCard 或公开目录。

非成员回合 SHALL 不注入：persona 未在岗任何岗位、或一个 persona 同时占据多个岗位（归属歧义）时，回合 prompt SHALL 与现状逐字一致。归属判定 SHALL 复用报数面既有的归属解析，不引入第二套判定。

#### Scenario: 有节奏岗回合带身份

- **WHEN** 一个绑定 persona 的有节奏岗位到点触发回合
- **THEN** 该回合的 prompt 首部含一行岗位身份，五个字段（fleetId / memberId / 目标引用 / 岗位名 / 回合标识）与实际岗位及该轮落地标识一致
- **AND** 该回合的会话史首条用户消息含同一行

#### Scenario: 被动岗受委托回合带身份

- **WHEN** 一个无节奏的被动岗被另一个 agent 通过 delegation 唤醒
- **THEN** 该回合的 prompt 首部同样含岗位身份行（含回合标识）

#### Scenario: 回合标识逐轮轮换

- **WHEN** 同一岗位连续两轮定时回合分别落地
- **THEN** 两轮身份行的 turn 值互不相同，且各自等于该轮实际使用的子会话/回合标识

#### Scenario: 非成员回合不注入

- **WHEN** 普通对话由一个未在岗任何舰队岗位的 persona 执行
- **THEN** 回合 prompt 与现状逐字一致，不含身份行

#### Scenario: 归属歧义不注入

- **WHEN** 执行回合的 persona 同时占据两个岗位
- **THEN** 不注入身份行（与报数面对歧义的诚实拒绝一致）

#### Scenario: 身份不含凭据

- **WHEN** 检查注入的身份行内容
- **THEN** 其中只含舰队标识、岗位标识、岗位名、目标引用与回合标识，不含任何 token、密钥或凭据

### Requirement: 报数归属结果落事实列

报数归属的判定结果 SHALL 以事实列落进回合事件记录（`member_turn_events.detail.attribution`）：`source` SHALL 取 `turn`（按在飞回合归属）、`job-sourceTag`（按运行中任务的 sourceTag 归属）、`cluster-task`（cluster 扇出归属）、`preset`（按回合目标 preset 归属）、`none`（无归属）之一，并记 `fleetId` 与 `memberId`（不可得时如实为空）。该列 SHALL 是观测来源（不可推断），使「岗位报数被拒」可从台账直接判读。

#### Scenario: 归属成功时台账可读

- **WHEN** 某回合的 report_status 被受理并归属到某岗位
- **THEN** 该回合的 member_turn_events.detail.attribution 记 source 与 fleetId/memberId，与报数卡上的岗位一致

#### Scenario: 归属失败时台账可读

- **WHEN** 某回合的 report_status 被拒（归属无命中或歧义）
- **THEN** 拒绝原因如实回到调用方，运维无需翻日志即可从回合台账判读该回合是否有归属

### Requirement: 边回合按精简形态接上舰队上下文

派发、接棒、扇出、事件唤醒四类边回合的 persona 目标 SHALL 获得舰队上下文，渲染 SHALL 走与巡视轮**同一个执行侧注入缝**（每次执行恰好一次，渲染失败使该次执行显性失败）。边回合的上下文 SHALL 以独立占位符 `{{fleetEdgeContext}}` 声明，SHALL NOT 与巡视轮的 `{{fleetContext}}` 混用同一形态。

边回合形态 SHALL 包含：舰队在岗概况、直接下级岗位的最新报数摘要、本岗位自身最近轮次与近期执行健康。边回合形态 SHALL NOT 包含巡逻纪律尾段（其中"先报数再补充/调用 report_status"的指示针对巡视轮，对一条刚被交付任务的回合是反向指令），SHALL NOT 渲染决策送达段（送达是巡视轮的义务，在边回合消费会把未读裁决标记为已送达），且其总量上限 SHALL 小于巡视轮上限，使舰队背景不挤占回合自身的主料（派发 brief、上游结果、唤醒消息）。

a2a 目标与 tool 目标 SHALL NOT 注入：a2a 目标是其他服务的执行面；tool 岗位的 prompt 就是其 JSON 参数，追加文本会使之非法。tool 目标的 prompt SHALL 与 brief 逐字节相同。巡检轮（`{{fleetContext}}`）的渲染 SHALL 与本能力引入前逐字节等价。

#### Scenario: 派发到 persona 岗位拿到集群背景

- **WHEN** 岗位 A 派发 persona 岗位 B 并给出 brief，B 的回合开始
- **THEN** B 的起轮 prompt 含 brief 在前、集群背景在后；背景含在岗概况与 B 的直接下级最新报数，且不含巡逻纪律段

#### Scenario: 接棒与扇出同形

- **WHEN** 上游回合完成后依声明边接棒或扇出一波 persona 目标
- **THEN** 每个目标回合的 prompt 含上游结果与集群背景，占位符不残留

#### Scenario: 事件唤醒的岗位知道组织现状

- **WHEN** bot 入站消息唤醒绑定的 persona 岗位
- **THEN** 该回合 prompt 含该消息与集群背景（在岗概况 + 下级最新报数），不含巡逻纪律段

#### Scenario: a2a 与 tool 目标零注入

- **WHEN** 派发或唤醒命中 a2a 目标，或派发命中 tool 目标
- **THEN** a2a 的 prompt 不含任何舰队上下文 token；tool 的 prompt 与 brief 参数逐字节相同

#### Scenario: 边回合不消耗决策送达

- **WHEN** 某岗位存在未送达的裁决，且该岗位本轮是被派发/接棒/扇出/唤醒触发的
- **THEN** 该回合 prompt 不含裁决送达段，该裁决在该回合后仍为未送达

#### Scenario: 边回合渲染失败显性化

- **WHEN** 边回合的上下文渲染抛错
- **THEN** 该次执行记为失败且不起一轮无背景的裸回合

#### Scenario: 巡视轮零变化

- **WHEN** 岗位节奏模板含 `{{fleetContext}}`
- **THEN** 渲染结果与引入本能力前逐字节一致（含巡逻纪律尾段与决策送达段）
