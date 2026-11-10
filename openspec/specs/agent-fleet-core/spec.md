# agent-fleet-core Specification

## Purpose

把「舰队」立为 cell 的一等公民：一组按组织树编排的稳定岗位（Member），每个岗位绑定一个可替换的执行目标（persona/cluster/a2a）与一份节奏规格，节奏物化为既有任务引擎的定时任务并幂等对账。组织结构、岗位身份与历史在人员更替、节奏调整、暂停归档之间保持连续；执行真源始终是既有任务引擎，本能力不引入第二调度器。

## Requirements

### Requirement: 舰队与岗位是一等对象且岗位身份稳定

系统 SHALL 以持久化对象保存舰队(Fleet:名称、所有者、状态 active|paused|archived、创建时间、舰队级默认模型 defaultModel——可空模型声明)与岗位(Member:舰队内稳定标识、岗位名、父岗位引用组成组织树、KPI 槽位声明、节奏规格、在岗者引用 targetRef、模型声明 model 与 fallbackModel——均可空)。模型声明 SHALL 不参与岗位身份:改模型、清模型 SHALL 保持岗位标识、组织位置、KPI 槽位声明与会话史不变。targetRef SHALL 支持 persona、cluster、a2a、tool 四种目标并可在岗位生命周期内原子替换(换防);替换后岗位标识、组织位置、KPI 槽位声明 SHALL 保持不变。tool 目标(targetId 形如 `server::tool`,指向注册 MCP 服上的一个工具)SHALL 持有 JSON 参数节奏(promptTemplate 为合法 JSON 对象串,执行时作为工具参数原样传入);tool 岗的模型声明 SHALL 以结构化错误拒绝(无 LLM 回合,无处归位)。组织树 SHALL 允许多个顶层岗位(森林),并 SHALL 拒绝成环。

targetRef SHALL 另支持第五种目标 `auditor`(审计官)：只允许出现在已配置委托状的舰队中，其承载 SHALL 是受约束的 persona——工具面只含读（判例、决策历史、记忆）与结构化结论提交，MUST NOT 含写动作或对外发送工具；为 `auditor` 岗位保存含写或发送工具的工具面声明 SHALL 被服务端拒绝。未配置任何委托状的舰队新增 `auditor` 岗位 SHALL 被拒绝并提示需先配置委托状。`auditor` 目标 SHALL 遵守与 persona 相同的唯一在岗规则。

唯一在岗规则:一个 persona 或 cluster SHALL 同时只在一个岗位在岗——对已在岗对象的岗位引用(建岗或换防)SHALL 以结构化错误拒绝并指明现有岗位;a2a 与 tool 目标 SHALL 允许多岗(远程执行与无状态调用无归属歧义)。岗位引用 SHALL 不限制目标的日常使用(角色照常对话)。

换防语义:换防 SHALL 默认延续岗位的专属会话史;换防请求可显式选择清史重开(清会话对话史,报数史与槽位连续性不受影响)。**清史重开 SHALL 以「岗位下一回合在全新子进程对话上执行」为验收口径——其效果 MUST NOT 依赖运行时的会话删除能力：即使运行时不支持会话删除 RPC（静默失败被吞），清史后的下一回合也 MUST NOT 回放清史前的对话状态（生产 2026-10-25 实证：清史仅清了宿主镜像、子进程 2.36MB 会话原样续上）。镜像会话清空重建；报数史与 KPI 槽位连续性不受影响。**

#### Scenario: 建队建岗

- **WHEN** 用户创建舰队并添加一个岗位「电商部」,绑定 persona E、节奏每小时、无父岗位
- **THEN** 舰队与岗位落库,岗位出现在组织树顶层,且物化的定时任务在下一个整点触发该 persona 的回合

#### Scenario: 换防不断史

- **WHEN** 「电商部」岗位的 targetRef 从 persona E 原子替换为 persona F
- **THEN** 岗位标识、父岗位、KPI 槽位声明不变,后续节奏回合以 persona F 执行
- **AND** 岗位的历史(过往回合、既往报数与拍板)仍归属同一岗位可查

#### Scenario: 换防默认继承可选清史

- **WHEN** 主人执行换防且不勾选清史重开
- **THEN** 岗位专属会话的对话史延续,新在岗者接着既有对话执行
- **WHEN** 主人勾选清史重开
- **THEN** 岗位镜像会话清空重建,报数史与 KPI 槽位连续性不受影响
- **AND** 岗位下一回合在全新子进程对话上执行,不回放清史前的对话状态——即使运行时不支持会话删除 RPC 亦然

#### Scenario: 唯一岗拒绝

- **WHEN** 主人试图把岗位 B 换防给正在岗位 A 在岗的 persona E
- **THEN** 请求以结构化错误拒绝并指明 E 已在 A 岗;岗位 A 与 B 均不变

#### Scenario: 工具岗建岗

- **WHEN** 建岗 targetKind=tool、targetId=websearch::search、节奏每小时、promptTemplate 为 `{"query":"舰队 周报"}`
- **THEN** 岗位落库并物化 targetType=tool 的定时任务;同工具可另设一岗不被唯一岗规则拒绝

#### Scenario: 工具岗非法参数拒绝

- **WHEN** 建工具岗时 promptTemplate 不是合法 JSON 对象,或声明 model
- **THEN** 写面以结构化错误拒绝并指明原因

#### Scenario: 组织树拒绝成环

- **WHEN** 用户把岗位 A 的父岗位设为其后代岗位 B
- **THEN** 请求以结构化错误拒绝,树不变

#### Scenario: 改模型不动岗

- **WHEN** 岗位「电商部」的模型声明从 glm-4.7 改为 deepseek-v4.1-flash
- **THEN** 岗位标识、父岗位、KPI 槽位声明与目标不变;该岗下一回合以新声明执行

#### Scenario: 新增审计官岗位

- **WHEN** 主人在已配置委托状的舰队中新增一个 `targetRef.targetKind=auditor` 的岗位
- **THEN** 岗位创建成功，其工具面只含读与结论提交

#### Scenario: 审计官岗位拒绝写工具

- **WHEN** 有人尝试为 `auditor` 岗位保存一个包含写工具或对外发送工具的工具面
- **THEN** 服务端拒绝该保存并说明审计官不得持有写权限

#### Scenario: 未配置委托状的舰队不能设审计官

- **WHEN** 一个未配置任何委托状的舰队尝试新增 `auditor` 岗位
- **THEN** 创建被拒绝，并提示需先配置委托状

### Requirement: 节奏规格物化为任务引擎任务并幂等对账

节奏为岗位的可选属性：每个**有节奏**岗位的节奏规格（cron 表达式、IANA 时区、prompt 模板）SHALL 物化为任务引擎的 recurring 任务，任务记录 SHALL 携带舰队与岗位标识（fleetId/memberId）以区分于普通定时任务。**无节奏岗位（被动岗）** SHALL 不物化任务，仅在受委托或拍板批复唤醒时发起回合。物化 SHALL 幂等：同一节奏规格重复对账不产生重复任务；修改节奏规格后对账 SHALL 更新既有任务而非新建；删除岗位或归档舰队 SHALL 使对应物化任务停止且不再产生新回合。全队暂停 SHALL 批量暂停全部物化任务，恢复 SHALL 逐岗恢复且尊重岗位自身暂停态。

#### Scenario: 重复对账无副作用

- **WHEN** 对同一舰队连续执行两次对账而节奏规格未变
- **THEN** 物化任务数量不变，任务的下一次触发时间不变

#### Scenario: 被动岗不物化

- **WHEN** 用户创建不带节奏的岗位「助理岗」
- **THEN** 无物化任务产生，该岗位仅在受委托或拍板批复唤醒时执行回合

#### Scenario: 改节奏即改任务

- **WHEN** 岗位节奏从每小时改为每天 9 点并完成对账
- **THEN** 既有物化任务的调度被更新为新表达式，历史执行记录保留，不出现孤儿旧任务

#### Scenario: 撤掉节奏变被动岗

- **WHEN** 岗位节奏被清空并完成对账
- **THEN** 其物化任务停止并移除，岗位转为被动岗语义，历史保留

#### Scenario: 全队暂停即刹车

- **WHEN** 用户暂停整支舰队
- **THEN** 全部物化任务停止触发，在岗派生呈现暂停态；恢复后各岗位按自身节奏继续

### Requirement: 在岗与健康状态为派生视图系统 SHALL 从物化任务状态与执行历史派生每个岗位的状态：在岗（任务存在、未暂停、近期有执行或尚在首跑窗口）、暂停、失联（超过容忍窗口无执行，容忍窗口与节奏周期成正比）、被动（无节奏岗位的常态，失联判定不适用）、待补岗（targetRef 指向已不存在的对象）、**需关注（连续失败达阈值）**。派生状态 SHALL 不落库，读取时计算；待补岗岗位 SHALL 在管理面提供补岗（重新绑定 targetRef）动作。

**失败维度 SHALL 参与状态判定**：一个岗位最近连续失败回合数达到阈值（默认 3，可配置）时，其派生状态 SHALL 为「需关注」而非「在岗」——「最近一回合失败」MUST NOT 被渲染成与成功同形的正常态（2026-10-26 普查实证：某岗位连续失败 12 轮、状态仍为在岗，控制台全绿，无人值守线静默停摆而无人发现）。优先级 SHALL 为：待补岗 → 被动 → 暂停 → 失联 → **需关注** → 在岗；失联优先于需关注（连信号都没了比连败更严重）。判定依据 SHALL 随状态一并可读：连续失败数、本轮连败起始时刻、最近失败类别——三者 SHALL 在管理面（画布、岗位卡、检查器）显式可见，使运维能直接分流处置（运行时未就绪=平台侧、超时=预算或工具、上游 5xx=供应商）。中断（interrupted）SHALL NOT 计入连续失败（它不是岗位的错，且回合可重跑）。恢复语义 SHALL 为自动：下一个成功回合即清除该状态，无需人工干预。

**未执行（skipped）不冒充执行（全来源统一规则）**：presence 判据中的「最近一次执行」SHALL 只认真实回合（status ∈ ok|failed|interrupted 的事件；岗位尚无事件时退回任务引擎执行时点）——任何来源的 skipped（运行时未就绪短路、车道熔断开窗）SHALL NOT 推进该时点。skipped SHALL NOT 计入需关注的连败判定，也不中断/重置其连败链（透明跨过，同回合结果事件要求）。平台持续不可用超过容忍窗（窗口内只有 skipped、无任何真实回合）的岗位 SHALL 派生失联，判定依据明写「N 轮未执行：运行时不可用（或车道熔断）」而非笼统失联——该状语与停机补跑的 missed 文案（触发未发生）分列，二者 SHALL NOT 合并。

#### Scenario: 悬空诚实降级

- **WHEN** 岗位绑定的 persona 被用户删除
- **THEN** 岗位派生态变为待补岗并停止触发新回合，管理面显示补岗入口
- **AND** 用户为该岗位绑定新的 persona 后，节奏恢复且岗位历史连续

#### Scenario: skipped 不推进 presence

- **WHEN** 某岗位超过容忍窗口只有 skipped 记录（运行时持续不可用或车道熔断）
- **THEN** 派生状态呈现失联，判定依据写明「N 轮未执行：运行时不可用（或车道熔断）」

#### Scenario: skipped 不计入需关注

- **WHEN** 某岗位连续产生 5 条 skipped 记录而此前连败数为 0
- **THEN** 派生状态不进入需关注（连败维度无变化）；其后再产生真实失败时连败链从
  此前真实失败的情形继续累计

#### Scenario: 失联可判定

- **WHEN** 某按小时节奏的岗位超过两倍周期无任何执行记录
- **THEN** 派生状态呈现失联，并在管理面可见判定依据（上次执行时间与容忍窗口）

#### Scenario: 被动岗不失联

- **WHEN** 被动岗长期无任何执行
- **THEN** 派生状态呈现被动而非失联，仅其最近一次被唤醒的执行可查

#### Scenario: 连续失败降级为需关注

- **WHEN** 某岗位连续 3 个回合失败（如均为「运行时未就绪」），且最近一次执行仍在容忍窗内
- **THEN** 其派生状态为需关注，而非在岗
- **AND** 状态依据显示连续失败数、本轮连败起始时刻与最近失败类别
- **AND** 舰队的健康统计把它计入需关注，不计入正常

#### Scenario: 中断不计入连败

- **WHEN** 岗位最近一个回合为中断（运行中被重启打断），其前一个回合成功
- **THEN** 连续失败数为 0，状态不受影响

#### Scenario: 成功即自动恢复

- **WHEN** 一个需关注的岗位下一个回合成功
- **THEN** 派生状态立即回到在岗，无需人工清除

#### Scenario: 失联优先于需关注

- **WHEN** 某岗位既连续失败达阈值，又已超过容忍窗口无执行
- **THEN** 派生状态呈现失联（更严重的失效形态），需关注依据仍可读

### Requirement: 舰队管理面提供全生命周期操作

web 应用 SHALL 提供舰队管理面：舰队列表（名称、状态、成员数、整体在岗概况、默认模型、待拍板件数、最近活动时刻）、组织树视图（岗位卡：岗位名/在岗者/节奏或被动标记/派生态）、编队器（选择既有 persona/cluster/a2a 目标、命名岗位、设定节奏（可留空建被动岗）与组织关系）、以及暂停/恢复/归档/解散与成员增删改、换防操作。归档 SHALL 停止全部物化任务但保留全部历史可读；对已归档舰队 SHALL 拒绝节奏类写操作并以显式状态说明。过密节奏（触发间隔低于阈值）在创建时 SHALL 要求显式确认。

舰队列表 SHALL 支持**行内快速编辑**三类字段：名称、默认模型与状态（active↔paused），复用既有单舰队 PATCH 语义并以服务端返回值刷新该行；编导边与 effort/上下文预算 SHALL NOT 出现在行内编辑入口（需要 diff 确认与影响面提示，仅在驾驶舱提供）。舰队列表 SHALL 支持勾选多支舰队，经单一批量端点执行 暂停 / 恢复 / 归档，并在响应中逐条回执每个舰队的成功或结构化失败原因。批量动作 SHALL NOT 因单条失败而中断其余执行，MUST NOT 把部分失败呈现为全部成功。归档为终态，批量归档 SHALL 要求二次确认。

舰队管理面 SHALL 与综合看板（跨舰队聚合读面）共存于同一导航项，并以视图切换区分；舰队管理面 MUST NOT 取代或内嵌驾驶舱——每行 SHALL 提供直达该舰队驾驶舱的入口，既有 `/fleets/:id` 深链语义不变。

#### Scenario: 编队器建队

- **WHEN** 用户在编队器中选择两个 persona 与一个市场 a2a agent，命名三个岗位并设定节奏，提交建队
- **THEN** 舰队与三个岗位落库，各岗位物化任务就绪，管理面立即可见组织树

#### Scenario: 过密节奏需确认

- **WHEN** 用户为某岗位设定每分钟级节奏
- **THEN** 界面呈现成本警示并要求显式确认，未确认不落库

#### Scenario: 归档保史

- **WHEN** 用户归档一支舰队
- **THEN** 其全部物化任务停止，舰队态转为 archived，历史回合记录仍可读，且对归档舰队的节奏修改被拒绝并说明原因

#### Scenario: 行内改默认模型

- **WHEN** 主人在舰队列表某行把默认模型从 A 改为 B
- **THEN** 该行以服务端返回的默认模型呈现，未声明模型的岗位其生效模型随之变化，其他舰队不受影响

#### Scenario: 行内不暴露编导与预算

- **WHEN** 主人查看任一舰队行的可编辑控件
- **THEN** 只有名称、默认模型、状态三类入口，不存在编导边或 effort/上下文预算的编辑入口

#### Scenario: 批量暂停逐条回执

- **WHEN** 主人勾选 4 支舰队执行暂停，其中 1 支已归档
- **THEN** 其余 3 支进入 paused，归档那支以结构化错误回执（终态不可变更），界面呈现成功 3 / 失败 1 并列出失败原因

#### Scenario: 管理行直达驾驶舱

- **WHEN** 主人在舰队管理某行点「进驾驶舱」
- **THEN** 路由进入 `/fleets/<该舰队 id>` 并呈现该舰队驾驶舱，而非在管理面就地展开

### Requirement: 舰队操作经 REST API 暴露且鉴权与既有面一致

舰队与岗位的全生命周期操作 SHALL 以 REST API(/api/fleets 前缀)暴露,鉴权与身份语义 SHALL 与既有集群/定时任务面一致(auth-on 走 forward-auth 用户,auth-off 归机器主人);用户 SHALL 只能读写自己拥有的舰队。非法输入(缺岗位名、非法 cron、未知 targetRef 类别)SHALL 以结构化错误拒绝且不落库。

模型声明的写面:建岗与改岗 SHALL 接受可选 `model` 与 `fallbackModel`(`null` = 清除,回到继承);舰队设置面 SHALL 接受可选 `defaultModel`。校验 SHALL 复用既有三闸——标识符形状、宿主模型 roster、计费车道(已绑计费才校验)——失败 SHALL 以结构化错误如实拒绝并指名违反的是哪一闸。`fallbackModel` 仅在 `model` 非空时可设;清空 `model` 时 `fallbackModel` 仍非空 SHALL 拒绝并提示先清兜底。a2a 岗位与 cluster 岗位设置模型 SHALL 拒绝(a2a 的模型归该服务的部署配置,集群岗归各成员岗位)。所有返回岗位读面的接口 SHALL 带 `model`、`fallbackModel` 原值与 `effectiveModel`——由服务端按解析链与读时 roster 计算,标注 advisory(读时与回合时 roster 可能漂移)。

配置维度的写面:建岗 SHALL 与改岗接受同一组可选字段 `effort`、`contextBudget`、`carrier`、`packId`(`null`/`""` = 清除声明),校验 SHALL 复用与改岗逐条相同的闸——思考深度取已知模型声明档位的并集、上下文上限为正有限数、`carrier` 属枚举、`packId` 为非空串且不超长。合法请求 SHALL 把四项原值落到岗位行并在读面回显;任一门拒绝 SHALL 以结构化错误如实拒绝且 SHALL NOT 落库。服务端 SHALL NOT 接受一个字段却在建岗时静默丢弃它。

批量写面 SHALL 以 `POST /api/fleets/batch` 提供,请求体为 `{action, ids}`,`action` SHALL 限于 `pause`/`resume`/`archive`,`ids` SHALL 为舰队 id 数组且长度受运营策略上限约束(默认 50,超限以结构化错误拒绝整批且不执行任何一条)。服务端 SHALL 逐舰队串行执行既有单舰队语义并在 `results[]` 中逐条返回成功或结构化失败原因;单条失败 MUST NOT 中断其余执行;请求体合法时 HTTP 状态 SHALL 为 200。越权 id SHALL 以与「不存在」一致的失败呈现,不泄漏他舰队任何内容。

#### Scenario: 越权拒绝

- **WHEN** 用户 A 请求修改用户 B 的舰队
- **THEN** 请求被拒绝且不产生任何变更

#### Scenario: 非法 cron 拒绝

- **WHEN** 创建岗位时提交非法 cron 表达式
- **THEN** 返回结构化错误,无岗位与物化任务产生

#### Scenario: 建岗带模型回显

- **WHEN** 主人建岗时带 `model: "cheap-model"`,随后 PATCH 改为 `null`
- **THEN** 建岗后岗位读面回显 `model: "cheap-model"`,PATCH 后回显 `null` 且 `fallbackModel` 同样为 null

#### Scenario: 三闸拒绝指名

- **WHEN** 主人建岗时带不在宿主 roster 里的 `model: "ghost-model"`
- **THEN** 返回结构化错误且文案指名「不在宿主模型 roster」,岗位不落库

#### Scenario: 兜底缺首选拒绝

- **WHEN** 主人 PATCH 岗位只设 `fallbackModel` 而 `model` 为空,或置 `model: null` 时 `fallbackModel` 仍非空
- **THEN** 均以结构化错误拒绝并提示兜底依赖首选,岗位模型声明不变

#### Scenario: 非 persona 岗位设模型拒绝

- **WHEN** 主人给 targetRef 为 a2a 或 cluster 的岗位设置 `model`
- **THEN** 以结构化错误拒绝并说明模型归服务部署配置/各成员岗位

#### Scenario: 读面带生效模型

- **WHEN** 岗位未声明模型而舰队设了 `defaultModel`,主人读取舰队详情
- **THEN** 岗位读面 `model` 为 null、`effectiveModel` 为舰队默认(该模型在读时 roster 中命中)

#### Scenario: 建岗带全配置维度回显

- **WHEN** 主人建岗时带 `effort`、`contextBudget`、`carrier`、`packId` 四个合法值
- **THEN** 该请求返回 201,且岗位读面逐项回显这四个值(与随后用 PATCH 写同样的值等价)

#### Scenario: 建岗非法思考深度拒绝且不落库

- **WHEN** 主人建岗时带一个任何已知模型都不声明的 `effort` 档位
- **THEN** 返回结构化错误并列出可选档位,岗位不被创建

#### Scenario: 建岗未知 carrier 拒绝

- **WHEN** 主人建岗时带不在枚举内的 `carrier`
- **THEN** 返回结构化错误并列出可选值,岗位不被创建

#### Scenario: 建岗超长 packId 拒绝

- **WHEN** 主人建岗时带超过长度上限的 `packId`
- **THEN** 返回结构化错误,岗位不被创建

#### Scenario: 批量端点越权 id 逐条拒绝

- **WHEN** 批量请求的 ids 含一个不属于当前主人的舰队 id
- **THEN** 该 id 在 `results[]` 中以失败返回,同批其余属于该主人的舰队照常执行,响应不泄漏该舰队任何内容

#### Scenario: 批量 ids 超上限整批拒绝

- **WHEN** 批量请求的 ids 数超过上限
- **THEN** 端点以结构化错误拒绝整批,不执行其中任何一条

### Requirement: 舰队节奏对外只读契约

系统 SHALL 提供一个只读查询：给定舰队标识，返回该舰队在岗岗位的节奏与目标位，每岗含岗位标识、岗位名、cron 表达式、IANA 时区与在岗目标引用（kind + id）。无节奏的被动岗 SHALL 以空 cron/时区返回，供调用方判定其不参与节奏等价比较。

该查询 SHALL 仅返回节奏与目标位，SHALL NOT 返回 KPI 槽位声明、报数史、拍板记录、会话内容或任何凭据。作用域 SHALL 与舰队其余管理读面一致（仅舰队所有者可读）；未知或非本人舰队 SHALL 以既有语义拒绝。

用途：外部内容系统在**创建刷新调度**时查询岗位节奏，命中「与某岗位节奏等价且目标同一产物」即拒绝并指向该岗位（跨系统冲突单侧无法判定，故由持有节奏的一侧提供事实）。

#### Scenario: 返回在岗岗位的节奏与目标位

- **WHEN** 所有者查询某舰队的节奏契约
- **THEN** 响应含每个在岗岗位的岗位标识、岗位名、cron、时区与目标引用
- **AND** 响应不含 KPI 槽位、报数、拍板或凭据

#### Scenario: 被动岗如实返回空节奏

- **WHEN** 舰队中存在无节奏的被动岗
- **THEN** 该岗在响应中 cron 与时区为空，其余字段照常

#### Scenario: 非本人舰队被拒

- **WHEN** 非所有者查询该舰队的节奏契约
- **THEN** 请求以既有作用域语义拒绝，不泄露任何岗位信息

### Requirement: 岗位模型按解析链归位执行

每个 persona 岗位回合 SHALL 在回合开始时把运行时模型归位到解析链的第一个 roster 命中档——`[岗位 model, 岗位 fallbackModel, 舰队 defaultModel, cell 默认]`,去空去重,与 persona 归位同构、不依赖上一回合残留。解析输入 SHALL 于回合执行时从岗位/舰队表现查,不物化进任务记录。链中某档已声明但 roster 不含(写时校验不保证运行时有效)SHALL 落到下一档继续,并在回合执行记录留痕指名失效档;该回合存在报数行时 SHALL 同步记入报数 blockers。未声明(null)SHALL 安静继承,不记异常。全链无命中或 roster 为空 SHALL 使回合如实失败,不硬造模型。兜底 SHALL 仅发生在选型时;模型已入选但执行中失败(provider 故障、超时)SHALL 维持既有回合失败语义,等下个节奏自然重试,SHALL NOT 执行中换模型重跑。岗位回合用量 SHALL 按实际运行的模型计入既有 turn 记录。集群汇总回合 SHALL 以首个成功成员的解析结果模型运行。a2a 岗位回合不受解析链影响。

#### Scenario: 岗位模型归位执行

- **WHEN** 岗位声明模型 A 且运行时停在其它模型上,节奏回合触发
- **THEN** 该回合以模型 A 运行,该回合的用量记录显示模型 A

#### Scenario: 改模型下一回合生效

- **WHEN** 岗位模型从 A 改为 B,下一个节奏回合触发
- **THEN** 该回合以 B 运行(允许一次重启),不静默沿用 A

#### Scenario: 未声明岗位不被残留污染

- **WHEN** 混编舰队中岗位甲声明模型 X 跑完回合,未声明模型的岗位乙随即触发
- **THEN** 乙的回合归位到舰队默认或 cell 默认,乙的用量记录不出现 X

#### Scenario: 声明失效回落留痕

- **WHEN** 岗位声明的模型已从宿主 roster 移除,舰队设了 defaultModel,回合触发
- **THEN** 回合成功落舰队默认执行,执行记录(及存在的报数行)指名「岗位模型已失效,落舰队默认」

#### Scenario: 全链无命中如实失败

- **WHEN** 岗位与舰队均未声明模型且 cell 无可用模型,或声明档全部失效且无兜底
- **THEN** 回合以结构化错误如实失败,不虚构模型执行

### Requirement: 成员回合产出回合结果事件

每次舰队成员回合结束或被如实判定为未执行,系统 SHALL 追加一条回合结果事件并持久化,至少含:舰队标识、岗位标识、触发源 source(cron 节奏回合 / 拍板批复 execute-now(manual) / delegation 唤醒 / event 信号唤醒四值)、status(ok|failed|interrupted|**skipped**)、errorKind、错误摘要 error、执行模型 model、起止时刻 startedAt/endedAt、来源会话 sessionId、执行实例标识 runId、链位 parentTurnId 与 edgeKind(根回合为空)、用量 usage(输入/输出 token,运行时未报则为空)、trace 关联键 traceTurnId(无法关联则为空)、**归因摘要 detail(可空 JSON:超时回合的最后工具与等待形态、降级记录 degradedTo、执行车道 laneId)**。事件 SHALL 只增不改;岗位归属解析 SHALL 复用既有归属判定(resolveAttribution),不引入第二套身份判定;非舰队回合(无舰队归属的普通定时任务与人工会话)SHALL 不产出事件。

**skipped 语义（两源同形，presence 统一不推进——2026-10-27 仲裁）**：「本轮未执行」有两个如实来源，记录形态完全一致：① **运行时未就绪短路**——persona 回合经就绪等待仍不就绪（见「回合触发前的运行时就绪等待」）；② **车道熔断开窗**——模型车道处于熔断开窗期的回合被平台主动跳过（见 cron-module 熔断要求）。skipped 的回合未消耗预算、未产出、无副作用，SHALL 记 status=skipped、errorKind 如实（runtime_not_ready / model_upstream），SHALL NOT 计入岗位连续失败（不是岗位的错），SHALL NOT 使岗位判「需关注」，也 SHALL NOT 中断或重置其连败链（透明跨过，连败起始时刻与最近失败类别不被 skipped 行触碰）。skipped SHALL NOT 推进 presence/在岗派生的「最近一次执行」时钟（全来源统一规则，见「在岗与健康状态为派生视图」）——持续不可用超过容忍窗的岗位派生失联并在判定依据写明未执行轮数，这不是假失联而是真相，与停机 missed（未触发）语义同构但文案分列。运行时短路的 skipped SHALL 不开执行实例（runId/parentTurnId/edgeKind 为空），同一触发时刻同一岗位同一来源 SHALL 最多产生一条 skipped（同一秒批量不得放大为 N 条）。skipped 与 failed、interrupted 三者 SHALL 在管理面可区分。

**超时归因**：timeout 事件 SHALL 在写时携带归因摘要——最后成功/挂起调用的工具名、该调用已等待时长、已执行步数，并 SHALL 区分 `turn_budget_exceeded`（工具正常返回但步数耗尽）与 `stalled`（某次调用长时间无返回）；无工具调用史的超时 SHALL 以诚实空缺而非估算值填充。降级重试 SHALL 在 detail 记 `degradedTo`（实际接棒的模型档）。

errorKind SHALL 在写时从错误文本与形状归类为有限枚举:模型/上游(model_upstream)、工具/权限(tool_permission)、运行时未就绪(runtime_not_ready)、超时(timeout)、业务拒绝(business_refused)、上下文预算(context_budget)、其余(other);归类 SHALL 为纯函数可测,未识别错误 SHALL 落 other 而非丢弃。

事件 SHALL 有界保留且采用双条件:一条事件仅当同时「早于保留窗(默认 30 天)」且「超出该岗位最近 N 条下限(默认 200)」时才可被裁剪;裁剪 SHALL 只删最旧事件且不影响报数与拍板历史。同一岗位的连续失败次数 SHALL 可从事件流聚合读取,不要求独立计数存储;一次成功回合后连续计数 SHALL 归零。

#### Scenario: 失败回合产出事件

- **WHEN** 某岗位的 cron 节奏回合因模型上游不可用而失败
- **THEN** 该岗位追加一条 status=failed、source=cron 的事件,errorKind=model_upstream,错误摘要与来源会话可查,且携带 runId

#### Scenario: 未执行回合产出 skipped 而非失败

- **WHEN** 某岗位的 cron 节奏回合触发时运行时经有界等待仍不就绪
- **THEN** 该岗位追加至多一条 status=skipped、errorKind=runtime_not_ready 的事件，无 runId、无 usage；同一触发批次不放大为多行

#### Scenario: skipped 透明跨过连败链

- **WHEN** 某岗位依次产生 real-failed、skipped、real-failed 三条记录
- **THEN** 连续失败计数为 2（两条真实失败的连续性不被 skipped 中断，skipped 自身不计入）

#### Scenario: 被动岗唤醒回合产出事件

- **WHEN** 无节奏的被动岗因 delegation 唤醒执行了一回合并成功
- **THEN** 该岗位追加一条 source=delegation、status=ok 的事件,含起止时刻、执行模型、usage,以及继承自发起回合的 runId 与 parentTurnId、edgeKind=dispatch

#### Scenario: errorKind 分类纯函数

- **WHEN** 分类函数收到「execution timed out」与一条无法识别的错误文本
- **THEN** 分别归类 timeout 与 other,过程不访问任何外部状态

#### Scenario: 非舰队回合零扰动

- **WHEN** 用户的一个普通定时任务(非舰队物化)执行并失败
- **THEN** 不产生任何回合结果事件

#### Scenario: 有界保留

- **WHEN** 某岗位有一条事件早于保留窗但仍在该岗最近 200 条之内,另一条既早于保留窗又在 200 条之外
- **THEN** 仅后者被裁剪,前者保留;报数与拍板历史不受影响

#### Scenario: 用量缺失不虚构

- **WHEN** 运行时在某回合未上报 usage
- **THEN** 该事件 usage 为空,不以估算值填充

#### Scenario: 连续失败聚合归零

- **WHEN** 某岗位连续 3 次失败后执行了一次成功回合
- **THEN** 该岗位连续失败计数从 3 归零,事件流保留全部 4 条记录

#### Scenario: 超时回合可归因

- **WHEN** 某岗位回合超时,其最后一次工具调用为 web_fetch 且自调用起无返回,此前已完成 12 次调用
- **THEN** 事件 errorKind=timeout 且 detail 标注 kind=stalled、lastTool=web_fetch、该调用已等待时长、steps=13

#### Scenario: 预算耗尽与挂死可区分

- **WHEN** 一个回合的全部工具调用都有返回、仅步数耗尽
- **THEN** detail.kind=turn_budget_exceeded,运维据此加预算或改 prompt 而非修工具

#### Scenario: 熔断开窗期记 skipped

- **WHEN** 模型车道熔断开窗期内某岗位回合触发
- **THEN** 事件 status=skipped、detail 含车道指纹，该岗位连续失败数不增、连败链不断；
  skipped 不推进其 presence 时钟——持续熔断超容忍窗后该岗判失联并注明未执行轮数

#### Scenario: 降级重试留痕

- **WHEN** 岗位主档模型上游 5xx 快速失败且解析链存在下一档
- **THEN** 本回合以下一档模型重试一次,detail.degradedTo 记录接棒档;成功则回合 status=ok

#### Scenario: 桩输出不得结算为成功

- **WHEN** 一个回合以 ok 结束，但输出 tokens 不超过桩阈值（默认 128）、没有任何文本产出、没有任何工具调用、也没有报数
- **THEN** 该回合 SHALL 结算为 `interrupted`（可重跑、不推进在场），且 `detail` SHALL 含 `stubTurn: true` 与该判定的依据（输出 tokens、是否有工具调用、是否有报数）
- **AND** 四项中任一项不成立（有文本 / 有工具调用 / 有报数 / 输出超过阈值）时，行为 SHALL 与引入本条款前逐字节一致

#### Scenario: 窗口塞满型与从未真跑型可分

- **WHEN** 一个回合的输入达到解析窗口的 95% 以上
- **THEN** `detail` SHALL 含 `windowFull: true` 与该回合的输出 tokens
- **AND** 结算 SHALL NOT 仅凭窗口占用判定失败——那是观测字段，不是结论

#### Scenario: 正常短回合不被误伤

- **WHEN** 某岗位回合只调用一次 `report_status` 就结束（输出 tokens 很少）
- **THEN** 因为有工具调用与报数，该回合 SHALL 仍按 `ok` 结算

#### Scenario: 声明了必交报却未交的回合可被判读

- **WHEN** 某岗位的人设声明了「收尾必 report_status」，其回合以 `ok` 结束但本回合没有任何完成的 `report_status` 调用
- **THEN** 该回合 SHALL 仍记 `status=ok`（回合确实跑完），且 `detail` SHALL 含 `missingReport: true`
- **AND** 交付率读面 SHALL 能把该回合与"已交付"的 `ok` 回合区分开

#### Scenario: 未声明必交报的岗位不被判违约

- **WHEN** 某岗位人设没有声明必交报（例如只在被委派时起回合的内容岗）
- **THEN** 其 `ok` 回合 SHALL NOT 带 `missingReport`，行为与引入本条款前一致

#### Scenario: 失败与中断回合不参与交付契约判定

- **WHEN** 某声明了必交报的岗位回合以 `failed` / `interrupted` / `skipped` 结束
- **THEN** 该回合 SHALL NOT 被判 `missingReport`——交付契约只在"回合成功跑完"的前提下才有意义
- **AND** 一个回合 SHALL 只被一条规则判：巳判为桩（`stubTurn`）的回合 SHALL NOT 再被判 `missingReport`

#### Scenario: 契约标记来自人设而非散文匹配

- **WHEN** 平台合成运行时 profile（写入 `presets.patch.yml`）
- **THEN** SHALL 在同一刻用手里的人设文本判定是否声明必交报，并把结论发布给结算面
- **AND** 结算 SHALL 读该结论，SHALL NOT 在每回合对散文做正则匹配，也 SHALL NOT 依赖平台 catalog（活 cell 里可能为空）

### Requirement: 回合触发前的运行时就绪等待

依赖本地运行时的回合（persona 形态）SHALL 在开火前等待运行时进入就绪：经有界等待（默认 120 秒，部署可配）轮询就绪——等待吸收运行中桥重启窗（预设切换/catalog 同步/凭据 patch/崩溃重拉）与冷 cell 启动窗。等待 SHALL 能区分「重启中且即将回来」与「从未就绪」两种状态（桥 SHALL 暴露重启态），且**一旦观察到重启中，等待 SHALL 以粘性方式延长至多一个额外等待窗**（延长不随后续非重启轮询收回——重启结束后子进程仍需启动时间，收回宽限会在最需要它的时刻超时）。

等待耗尽仍不就绪 SHALL 先把该回合判为**可重试**，由调度侧按有界阶梯（默认 30s / 90s / 180s）**重排队同一回合**（同一任务记录重入串行队列：同一 prompt、同一排期槽，SHALL NOT 另开新一轮）；阶梯耗尽后 SHALL 走「未执行」短路（记 skipped，见回合结果事件要求），SHALL NOT 记 failed。重试计数 SHALL NOT 挂在回合对象副本上（回合入口会做浅拷贝），SHALL 按任务 id 独立记录，并在**回合真正开始**或**阶梯耗尽**时清零。重排队失败（任务已不存在/已在队列）SHALL 记为 skipped，SHALL NOT 记为已投递。

等待 SHALL 只针对就绪位；预设切换的占用冲突（stayed busy 一族）语义不变。就绪等待与短路 SHALL 在开执行实例（run ledger begin）之前完成：skipped 回合不留实例痕迹（重试回合同样不留）。

#### Scenario: 有界等待吸收桥重启窗

- **WHEN** 某岗位回合开火时运行时处于桥重启中段，数秒后恢复就绪
- **THEN** 该回合等待后就绪并正常执行，事件流中无任何失败或 skipped 记录

#### Scenario: 重启中的等待不被预算提前耗尽

- **WHEN** 凭据投递（重连市场/续期线路令牌）触发子进程重启，排定回合在重启窗内开火
- **THEN** 等待覆盖该重启（至多多花一个等待窗），子进程就绪后该回合正常执行；SHALL NOT 因重启窗耗尽原始预算而记 skipped

#### Scenario: 等待耗尽先重试再短路

- **WHEN** 运行时持续不就绪超过等待上限，且该回合尚未用尽重试阶梯
- **THEN** 平台按 30s / 90s / 180s 重排队同一回合，事件流记一条 status=skipped 且带 `retried` 标记（如实表明"本轮未执行但已重排"）；阶梯耗尽后的那一次才是不带重试的终局 skipped

#### Scenario: 等待耗尽记一条 skipped

- **WHEN** 运行时持续不就绪超过等待上限，且重试阶梯已用尽
- **THEN** 该批触发记一条终局 status=skipped 事件后不动作；下一排定周期独立评估，不补偿本批
  （阶梯未用尽时先按上面的重排队场景处理——同一批不产生两条终局 skipped）

#### Scenario: 同秒扇入塌缩为一

- **WHEN** 同舰队 9 个岗位的回合因同一分钟触发而串行入队，运行时恰处于重启窗
- **THEN** 首个回合的等待吸收了窗口期，其余岗位就绪后正常执行；至多产生 1 条 skipped
  而非 9 条 0 秒失败

### Requirement: 回合结果事件可查询

系统 SHALL 提供回合结果事件的读面:成员级时间线(按岗位分页倒序,含 nextBefore 游标,同报数时间线形态)与舰队级过滤查询(按 status 与 source 过滤)。读面 SHALL 仅暴露事件字段,不携带凭据或会话正文;owner 作用域与舰队读面一致。

#### Scenario: 成员时间线分页

- **WHEN** 请求某岗位的回合时间线并传入上一页返回的 nextBefore
- **THEN** 返回更早一页事件,字段完整且无凭据与会话正文

#### Scenario: 舰队级失败过滤

- **WHEN** 请求舰队回合事件并指定 status=failed
- **THEN** 仅返回该舰队失败事件,含岗位标识与 errorKind

### Requirement: 工具岗回合以确定性工具调用执行

工具岗的回合 SHALL 不经 LLM:执行器 SHALL 将节奏 promptTemplate 解析为 JSON 参数、按 targetId 路由到注册 MCP 服、以 MCP 客户端调用该工具一次,并将工具返回(或错误)以 JSON 文本落入该回合会话。回合结果 SHALL 经既有回合收口产出 O1 事件(model 为空如实),失败 SHALL 结构化分类:参数非 JSON(runtime_not_ready)、server 不可路由(runtime_not_ready)、工具执行错误(other 或按文本归类)。工具岗回合 SHALL 可作为 dispatch 与 handoff 的目标(走 manual 任务车道,targetType=tool),护栏与链深规则与 persona/a2a 一致。

#### Scenario: 确定性回合

- **WHEN** 工具岗 websearch::search 的节奏回合触发
- **THEN** 该工具被调用一次、参数为声明的 JSON、结果 JSON 落会话,O1 事件 status 如实且 model 为空

#### Scenario: 派发到达工具岗

- **WHEN** supervisor 模式下主管岗 dispatch_post 到工具岗
- **THEN** manual 任务以 targetType=tool 创建并按同一执行器运行,深度与频次护栏照常生效

### Requirement: 舰队行更新落双审计痕

fleets 表每次 UPDATE SHALL 在 fleet_row_audit 落一行审计记录（时间戳 / fleet_id /
本次变更的字段集 / orchestration 旧值→新值）——以库层 AFTER UPDATE 触发器实现，对任何
写入进程无差别生效，包括平台进程之外的直接 SQL 写入。平台进程内的舰队行更新 SHALL 附
归因（HTTP 请求身份，或进程内调用方首帧），归因随审计可查。orchestration 从非 null 变
为 null 的写，当归因缺失或不是该舰队 owner 的 HTTP 会话时，平台 SHALL 打 warn 日志。
/api/fleets 的非只读请求 SHALL 记访问日志（方法 / 路径 / 请求身份）。审计记录 SHALL NOT
包含凭据或密钥材料。

#### Scenario: 人为 PATCH orchestration 可查 caller 与新旧值

- WHEN owner 通过 PATCH /api/fleets/:id 修改 orchestration
- THEN fleet_row_audit 出现对应审计行（含时间戳、变更字段集、orchestration 旧值→新值、
  归因为该 owner 的 HTTP 会话）

#### Scenario: 进程外直接 SQL 写入仍被捕获

- WHEN 任意进程绕过平台 API 直接 UPDATE fleets 表（如 shell 直写库文件）
- THEN 触发器审计行照常落库（无应用层归因），据此可判读为进程外写入

#### Scenario: orchestration 复位为 null 打 warn

- WHEN 一次写使 orchestration 从非 null 变为 null,且归因缺失或不是该舰队 owner 的
  HTTP 会话
- THEN 平台日志出现 warn(含 fleet_id 与可得归因),审计行同时落库

#### Scenario: 非审计字段的常规更新不改变写语义

- WHEN owner 修改舰队名或状态等常规字段
- THEN 更新行为与审计前完全一致,仅追加审计行,无额外拒绝或延迟语义

### Requirement: 岗位可声明思考深度并按回合生效

舰队岗位 SHALL 可声明思考深度(effort),与模型声明同形的覆盖语义:岗位声明优先于舰队默认,舰队默认优先于 cell 默认;三者皆无声明时 SHALL 沿用既有的 provider 级全局思考深度,行为与本次变更前逐字节等价。声明的值 SHALL 在写面校验为该 cell 已知模型所支持档位的并集内,非法值 SHALL 被结构化拒绝并提示可选值。回合执行时 SHALL 按解析出的生效值切换运行时思考深度,且该切换 SHALL NOT 重启运行时进程;生效值与运行中值相同时 SHALL 跳过切换。声明了却被当前模型不支持时 SHALL 回落上一层声明并留下可读提示,回合 SHALL NOT 因此失败。

声明被清除(写面收到 `null` 或空串)后,该岗位下一回合的运行中思考深度 SHALL 切回 provider 级全局值,SHALL NOT 沿用上一回合或上一岗位遗留的活体档位。判据 SHALL 是「目标档位与运行中档位是否不同」,而非「目标档位是否有值」。

#### Scenario: 岗位声明生效

- **WHEN** 某岗位声明思考深度为 high 且其生效模型支持该档
- **THEN** 该岗位回合在 high 档执行,且执行期间运行时进程未重启

#### Scenario: 未声明零变化

- **WHEN** 岗位与舰队均未声明思考深度
- **THEN** 回合沿用 provider 级全局思考深度,行为与变更前一致

#### Scenario: 不支持的档位回落

- **WHEN** 岗位声明 high 但其生效模型只支持 low 与 medium
- **THEN** 回合按上一层声明(或全局值)执行,并在回合记录中留下该声明不可用的提示,回合不失败

#### Scenario: 非法值写面拒绝

- **WHEN** 以任何已知模型都不支持的档位更新岗位
- **THEN** 写面返回结构化错误并列出可选档位

#### Scenario: 清除声明后回到全局档位

- **WHEN** 岗位原声明 high 且运行中档位为 high,主人把该岗位 effort 置为 `null`,随后该岗位触发一个回合
- **THEN** 该回合在 provider 级全局档位执行,不再沿用 high;切换走 live `model/set` 路径,运行时未重启

#### Scenario: 档位未变不切换

- **WHEN** 岗位无声明且运行中档位已是 provider 级全局值
- **THEN** 该回合不发起思考深度切换调用,回合行为与变更前逐字节等价

### Requirement: 岗位可声明上下文使用上限并如实判定

舰队岗位 SHALL 可声明单回合上下文使用上限(context budget),与思考深度同形的覆盖语义;未声明 SHALL 表示不限,行为与变更前一致。上限 SHALL 在回合收口时依据运行时上报的用量判定:用量存在且超出上限时,该回合 SHALL 记为失败并归类为上下文超预算,错误摘要 SHALL 同时给出实际用量与上限;运行时不报用量时 SHALL NOT 判定(不得以虚构用量判失败)。系统 SHALL NOT 为该上限静默截断对话或改写既有回合内容。

#### Scenario: 超预算回合如实失败

- **WHEN** 某岗位声明上限 8000 而该回合上报用量 9000
- **THEN** 该回合记为失败、归类为上下文超预算、摘要含 9000 与 8000

#### Scenario: 未声明不限

- **WHEN** 岗位未声明上限
- **THEN** 任何用量都不触发该判定,行为与变更前一致

#### Scenario: 无用量不判

- **WHEN** 运行时为该回合未上报用量
- **THEN** 不进行超预算判定,不回填虚构用量,回合结果只取决于其真实执行状态

### Requirement: MemberView 对 bot 类岗位附只读 bot 摘要

MemberView SHALL 在 `target.kind === "bot"` 的岗位附带只读 `bot` 摘要子对象：`{ enabled, lastInboundAt, lastOutboundAt, lastError }`。摘要 SHALL 从 bot 通道存储做 best-effort 映射：列缺 → null，`enabled` 反映 bot 配置开关（false ≠ 红）。该字段 SHALL NOT 引入新 bot 采集机制，亦 SHALL NOT 触发 bot 写操作。

#### Scenario: bot 类岗位带摘要

- **WHEN** cockpit 聚合返回一个 target.kind=bot 的岗位，其所绑 bot 已上线并最近收到一条入站消息
- **THEN** MemberView.bot.enabled=true，lastInboundAt 为该消息时刻，画布对节点呈现 bot 原生图标 + presence 状态点

#### Scenario: bot 通道未配置

- **WHEN** bot 通道从未启用或从未收到任何消息
- **THEN** MemberView.bot.lastInboundAt 为 null，节点图标设灰阶，不渲染状态红点

### Requirement: 画布与检查器以 bot 原生形态呈现 bot 类岗位

fleet 画布与 post 检查器 SHALL 将 `target.kind === "bot"` 的岗位显示为 bot 原生图标（与 BotsPage 单源 BotPlatformIcons），并附通道专属状态点（presence 聚合态）。其余 kind（persona/cluster/a2a/tool/cron/event）图标语义 SHALL NOT 因本 change 改变。

#### Scenario: bot 节点图标原生

- **WHEN** 舰队含 bot 类岗位与 persona 类岗位
- **THEN** bot 节点与 persona 节点分别用 BotPlatformIcon 与既有 NODE_COLORS.persona 渲染，可一眼区分

#### Scenario: 检查器 top 卡呈现 bot 摘要

- **WHEN** 用户打开一个 bot 类岗位的检查器
- **THEN** config tab 顶部呈现 bot 摘要行（enabled、最近入站时刻、最近错误若有），且点击直达 BotsPage 对应 bot 卡

### Requirement: 舰队名册读面每请求只合并一次目录

舰队名册类读面（`GET /api/fleets`、`/api/fleets/overview`、`/api/fleets/owner/board`、`/api/fleets/:id`、`/:id/cockpit`，以及编排草稿校验与 apply、catalog 变更后的对账）SHALL 在同一请求（或同一对账轮次）内对合并目录取一次快照，并以该快照解析全部岗位目标；SHALL NOT 逐岗位重新合并目录。cron 任务表 SHALL 每请求列取一次并在各舰队之间复用。

合并目录的成本来自重读注册表快照、已装包清单与用户预设（生产实测单次约 30ms）。逐岗位合并使名册读成为 cell 事件循环上的秒级同步阻塞，而同一进程同时服务聊天 WebSocket，因此该阻塞会推迟会话首帧。

#### Scenario: 六十岗位的名册读只付一次合并

- **WHEN** 某舱主有 21 支舰队、60 个岗位，请求 `GET /api/fleets`
- **THEN** 该请求内的目录合并次数为 1，且不随岗位数增长

#### Scenario: 快照不改变在岗判定

- **WHEN** 同一请求内解析多个岗位的目标
- **THEN** 每个岗位的 `alive`/标签与逐岗位合并时一致（同一份目录快照）

### Requirement: 节奏周期计算按 (cron, 时区) 记忆化

`cronPeriodMs`（以及其上的 `staleWindowMs`）SHALL 对同一 `(cron, 时区)` 的记忆化结果复用，SHALL NOT 在每次读取时重新解析表达式。带时区的解析需为每次解析构造时区对象并在其中迭代——生产实测单次约 40ms（无时区 9ms）；名册读面对每个岗位都要推导容忍窗口，且在岗派生会再次询问，因此 60 岗位的名册读要付数秒纯日历运算，而同一进程同时服务聊天 WebSocket。

记忆化的键 SHALL 包含日期，使夏令时切换在次日读取时被采纳而不是被进程生命周期冻结；无时区与带时区 SHALL 是不同的键。记忆化 SHALL NOT 改变返回值语义（含不可解析表达式的 null）。

#### Scenario: 同一节奏重复推导只解析一次

- **WHEN** 一支舰队的多个岗位共用同一 `cron` 与 `tz`，一次名册读为每个岗位推导容忍窗口
- **THEN** 该 `(cron, tz)` 只解析一次，其余岗位复用同一周期值

#### Scenario: 记忆化不改变判定

- **WHEN** 同一 `(cron, tz)` 在记忆化前后分别求周期
- **THEN** 两次结果相同；不可解析的表达式两次都返回 null

### Requirement: 舰队名册行携带待拍板计数

舰队名册行 SHALL 携带 `openDecisions`（该舰队 `state='open'` 的拍板条数）。侧栏角标以名册行该字段为唯一来源；缺该字段时角标永远不会出现，故服务端 SHALL 在名册读面提供。

#### Scenario: 有待拍板时名册行可见

- **WHEN** 某舰队存在 1 条 open 决策，请求 `GET /api/fleets`
- **THEN** 该舰队行的 `openDecisions` 为 1

#### Scenario: 无待拍板时为 0

- **WHEN** 某舰队没有任何 open 决策
- **THEN** 该舰队行的 `openDecisions` 为 0（不是缺字段）

### Requirement: 拍板队列与管理面暴露裁决者身份与执行状态

舰队拍板队列读面与管理面 SHALL 能按路由（owner / deputy）过滤与查看拍板项，条目 SHALL 暴露裁决者身份（owner / deputy 及 deputy 所用模型）、裁决依据、执行事实（executed 时刻与会话）与结果派生来源；route=deputy 的条目 SHALL 与 owner 待办在视觉与计数上区分。fleet 主人对 route=deputy 的条目 SHALL 可执行收回（recall → 路由 owner）。

#### Scenario: 队列按路由分视

- **WHEN** 主人打开拍板管理面
- **THEN** 可分别查看「等你（route=owner）」与「常务岗（route=deputy，含裁决中/已裁决/跟踪中）」两个视图

#### Scenario: 主人收回委托

- **WHEN** 主人对一条 route=deputy 的 open 条目执行收回
- **THEN** 该条目转路由 owner 并计入主人角标，deputy 队列不再包含它

### Requirement: 岗位记忆独立于对话史存在

岗位的连续性 SHALL 由三层承载且边界清晰：对话史（岗位镜像会话，换防清史重开可清）、报数史与
KPI 槽位连续性（既有语义，任何换防不清）、**岗位记忆**（部署命名空间分区中的历史观测——成员 own
分区与团队 shared 分区，openspec: member-knowledge-profile；存量 `f/` 团队 project 观测原样保留
可读——openspec: fleet-turn-memory——永不删页，任何换防/清史/解散都不删除）。清史重开的「清」字
SHALL 限于镜像会话对话史；解散团队 SHALL NOT 删除已入记忆的历史观测（记忆归 owner——owner 经
oversight 只读可监督全部成员分区，openspec: agent-memory-foundation——不随资产销毁）。
回合注入侧由 fleetContext 记忆段接续（本 spec 不重复其渲染契约）。

#### Scenario: 解散不清记忆

- **WHEN** 主人解散一支已有历史观测的团队
- **THEN** 团队与物化任务按既有语义终止，其在部署命名空间分区与存量 `f/` project 中的观测原样保留、可检索（owner oversight 可读）

#### Scenario: 清史重开的边界

- **WHEN** 主人勾选清史重开换防
- **THEN** 镜像会话对话史清空重建，岗位记忆与报数史/KPI 槽位连续性均不受影响（与既有验收口径一致并扩展到记忆层）

#### Scenario: 接班者经记忆接续前任

- **WHEN** 换防后新在岗者首轮开火
- **THEN** 其 own 分区保留该岗位全部历史经验（token 归岗位不归模型实例），fleetContext 记忆段含最近换防观测（前任、清史与否）

### Requirement: 对外岗位的对话车道注入本队上下文

用户在对话车道与某个 preset 对话时，若该 preset 归因到某支智能体团队的 persona 岗位，
则起轮前 SHALL 为该轮注入本队上下文：本队成员清单（岗位标题、目标）与可派发目标集合；
清单 SHALL NOT 携带成员数据库标识（主键会被模型原样复述进访客可见回答）。
未归属任何团队的 preset SHALL NOT 注入，行为与现状一致。注入 SHALL 复用任务车道的上下文渲染器
（同一格式），且 SHALL NOT 包含节点、凭据、成本等内部运营信息。

#### Scenario: 前台拿到本队名单

- **WHEN** 访客在对话车道向前台岗位提问，且该 preset 归因到某队的 persona 岗位
- **THEN** 该轮 prompt 包含该队的成员清单与可派发目标（按岗位标题），前台无需猜测队友标识

#### Scenario: 名单不含数据库主键

- **WHEN** 注入本队名单
- **THEN** 名单每行只给岗位标题与目标，不出现成员主键，模型无从把内部 id 讲给访客

#### Scenario: 普通 preset 不受影响

- **WHEN** 用户与一个未归属任何团队的 preset 对话
- **THEN** 该轮 prompt 不含任何团队上下文段，行为与变更前一致

### Requirement: 派发按岗位标题寻址

派发请求的 `to` SHALL 接受本队成员的岗位标题（大小写不敏感）或成员标识；
解析 SHALL 限本队内。同名歧义 SHALL 以 400 拒绝并列出候选；跨队引用 SHALL 以 400 拒绝。

#### Scenario: 按标题派发命中

- **WHEN** 岗位以标题指向本队某个成员发起派发
- **THEN** 派发命中该成员并按既有同集群闸、限流与回执语义执行

#### Scenario: 同名歧义被拒

- **WHEN** 本队存在两个同名成员，派发按标题寻址
- **THEN** 请求以 400 拒绝并列出两个候选，不任选其一

### Requirement: 显式链岗位每阵强制模型断言

post 声明了显式链（model/fallbackModel 任一非空）时，回合起点 SHALL 无条件重新断言 runtime 默认模型——不复用 `ctx.session.model.id === target` 早退，以免与被外源改写过的 child 选择漂移重合。断言实现 SHALL 引擎会重启（initialize）或 live 切换（有 model/set RPC 时），两者都必须向 child 显式写入目标模型。**无显式链的岗位（cron/preset 默认）沿用既有早退优化**，不向 runtime 写任何模型。

#### Scenario: 显式链岗位遭受外源漂移后住院

- **WHEN** post 声明了 deepseek-v4.1-flash 链，而 child 会话被其他车道写入过 qwen3.8-flash
- **THEN** 下一阵 normalizeModelForJob 强制重新断言 deepseek，回合请求头 model 恢复 deepseek

#### Scenario: 无显式链岗位不开销

- **WHEN** 一个 cron-only 岗位无 model/fallbackModel 声明
- **THEN** 回合起点不作任何模型断言，沿用之前 child 状态

### Requirement: memberTurnEvents detail 增 modelMismatch 事实列

当请求头模型与岗位决议模型不一致时，该阵的 member_turn_events.detail SHALL 记录 `modelMismatch: { declared, resolved, observedHeader }`；一致时不得写入。该列 SHALL 是观测来源（不可推断），以便 veracity/运维可直接判读。

#### Scenario: 模型不一致被钉下一行脚注

- **WHEN** 某阵 runtime 实际发出 model=qwen 但链声明 deepseek
- **THEN** 该阵 detail.modelMismatch.model 分别为 declared=deepseek 与 observedHeader=qwen，运维能与 error 联合定性「漂移」

### Requirement: 模型不可用失败触发自愈重断言

当回合归因为上游模型拒绝（HTTP 400 `model_not_available` / `INVALID_MODEL` / `cannot find model`）且岗位存在显式链，cron-runner SHALL 在原中途尝试完成后追加**一次强制重断言重新 spawn + 重走整条链一次**；若一次就 recover，结局记 ok 且 detail.modelRectified=true；若重走仍败才按现口径记 failed。

#### Scenario: 中毒态一键自愈

- **WHEN** 上一阵外源写过 qwen，使本阵首次以 qwen 拿到 400 model_not_available
- **THEN** 引擎强制 reinitialize 到声明模型重跑一次，结局 ok 并在 detail 注明自愈事实
