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
