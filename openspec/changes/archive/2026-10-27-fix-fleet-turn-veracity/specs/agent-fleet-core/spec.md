## MODIFIED Requirements

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

### Requirement: 在岗与健康状态为派生视图

系统 SHALL 从物化任务状态与执行历史派生每个岗位的状态：在岗（任务存在、未暂停、近期有执行或尚在首跑窗口）、暂停、失联（超过容忍窗口无执行，容忍窗口与节奏周期成正比）、被动（无节奏岗位的常态，失联判定不适用）、待补岗（targetRef 指向已不存在的对象）、**需关注（连续失败达阈值）**。派生状态 SHALL 不落库，读取时计算；待补岗岗位 SHALL 在管理面提供补岗（重新绑定 targetRef）动作。

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

## ADDED Requirements

### Requirement: 回合触发前的运行时就绪等待

依赖本地运行时的回合（persona 形态）SHALL 在开火前等待运行时进入就绪：经有界等待（默认 120 秒，部署可配）轮询就绪——等待吸收运行中桥重启窗（预设切换/catalog 同步/凭据 patch/崩溃重拉）与冷 cell 启动窗；等待耗尽仍不就绪 SHALL 走「未执行」短路（记 skipped，见回合结果事件要求），SHALL NOT 记 failed，且 SHALL NOT 由本机制发起任何重试（下一排定周期自然再来）。等待 SHALL 只针对就绪位；预设切换的占用冲突（stayed busy 一族）语义不变。就绪等待与短路 SHALL 在开执行实例（run ledger begin）之前完成：skipped 回合不留实例痕迹。

#### Scenario: 有界等待吸收桥重启窗

- **WHEN** 某岗位回合开火时运行时处于桥重启中段，数秒后恢复就绪
- **THEN** 该回合等待后就绪并正常执行，事件流中无任何失败或 skipped 记录

#### Scenario: 等待耗尽记一条 skipped

- **WHEN** 运行时持续不就绪超过等待上限
- **THEN** 该批触发记一条 status=skipped 事件后不动作；下一排定周期独立评估，不补偿本批

#### Scenario: 同秒扇入塌缩为一

- **WHEN** 同舰队 9 个岗位的回合因同一分钟触发而串行入队，运行时恰处于重启窗
- **THEN** 首个回合的等待吸收了窗口期，其余岗位就绪后正常执行；至多产生 1 条 skipped
  而非 9 条 0 秒失败
