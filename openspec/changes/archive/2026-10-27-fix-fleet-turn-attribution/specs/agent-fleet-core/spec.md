# agent-fleet-core Delta

## MODIFIED Requirements

### Requirement: 成员回合产出回合结果事件

每次舰队成员回合结束,系统 SHALL 追加一条回合结果事件并持久化,至少含:舰队标识、岗位标识、触发源 source(cron 节奏回合 / 拍板批复 execute-now(manual) / delegation 唤醒 / event 信号唤醒四值)、status(ok|failed|interrupted|**skipped**)、errorKind、错误摘要 error、执行模型 model、起止时刻 startedAt/endedAt、来源会话 sessionId、执行实例标识 runId、链位 parentTurnId 与 edgeKind(根回合为空)、用量 usage(输入/输出 token,运行时未报则为空)、trace 关联键 traceTurnId(无法关联则为空)、**归因摘要 detail(可空 JSON:超时回合的最后工具与等待形态、降级记录 degradedTo、执行车道 laneId)**。事件 SHALL 只增不改;岗位归属解析 SHALL 复用既有归属判定(resolveAttribution),不引入第二套身份判定;非舰队回合(无舰队归属的普通定时任务与人工会话)SHALL 不产出事件。

**skipped 语义**：平台主动跳过（模型车道熔断开窗期，见 cron-module）SHALL 记 status=skipped——它 SHALL NOT 计入岗位连续失败（不是岗位的错），SHALL NOT 使岗位判「需关注」；lastRun/在岗派生照常推进（否则长故障窗后的岗位假失联）。skipped 与 failed、interrupted 三者 SHALL 在管理面可区分。

**超时归因**：timeout 事件 SHALL 在写时携带归因摘要——最后成功/挂起调用的工具名、该调用已等待时长、已执行步数，并 SHALL 区分 `turn_budget_exceeded`（工具正常返回但步数耗尽）与 `stalled`（某次调用长时间无返回）；无工具调用史的超时 SHALL 以诚实空缺而非估算值填充。降级重试 SHALL 在 detail 记 `degradedTo`（实际接棒的模型档）。

errorKind SHALL 在写时从错误文本与形状归类为有限枚举:模型/上游(model_upstream)、工具/权限(tool_permission)、运行时未就绪(runtime_not_ready)、超时(timeout)、业务拒绝(business_refused)、其余(other);归类 SHALL 为纯函数可测,未识别错误 SHALL 落 other 而非丢弃。

事件 SHALL 有界保留且采用双条件:一条事件仅当同时「早于保留窗(默认 30 天)」且「超出该岗位最近 N 条下限(默认 200)」时才可被裁剪;裁剪 SHALL 只删最旧事件且不影响报数与拍板历史。同一岗位的连续失败次数 SHALL 可从事件流聚合读取,不要求独立计数存储;一次成功回合后连续计数 SHALL 归零。

#### Scenario: 失败回合产出事件

- **WHEN** 某岗位的 cron 节奏回合因模型上游不可用而失败
- **THEN** 该岗位追加一条 status=failed、source=cron 的事件,errorKind=model_upstream,错误摘要与来源会话可查,且携带 runId

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
- **THEN** 事件 status=skipped,该岗位连续失败数不增,在岗派生不变,事件可与管理面上 failed/interrupted 区分

#### Scenario: 降级重试留痕

- **WHEN** 岗位主档模型上游 5xx 快速失败且解析链存在下一档
- **THEN** 本回合以下一档模型重试一次,detail.degradedTo 记录接棒档;成功则回合 status=ok
