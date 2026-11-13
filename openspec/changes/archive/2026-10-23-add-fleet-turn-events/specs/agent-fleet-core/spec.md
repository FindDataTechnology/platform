# agent-fleet-core Delta — add-fleet-turn-events

## ADDED Requirements

### Requirement: 成员回合产出回合结果事件

每次舰队成员回合结束,系统 SHALL 追加一条回合结果事件并持久化,至少含:舰队标识、岗位标识、触发源 source(cron 节奏回合 / 拍板批复 execute-now / delegation 唤醒三值)、status(ok|failed|interrupted)、errorKind、错误摘要 error、执行模型 model、起止时刻 startedAt/endedAt、来源会话 sessionId。事件 SHALL 只增不改;岗位归属解析 SHALL 复用既有归属判定(resolveAttribution),不引入第二套身份判定;非舰队回合(无舰队归属的普通定时任务与人工会话)SHALL 不产出事件。

errorKind SHALL 在写时从错误文本与形状归类为有限枚举:模型/上游(model_upstream)、工具/权限(tool_permission)、运行时未就绪(runtime_not_ready)、超时(timeout)、业务拒绝(business_refused)、其余(other);归类 SHALL 为纯函数可测,未识别错误 SHALL 落 other 而非丢弃。

事件 SHALL 有界保留:按岗位滚动限量保留最近 N 条(默认 200),裁剪 SHALL 只删最旧事件且不影响报数与拍板历史。同一岗位的连续失败次数 SHALL 可从事件流聚合读取,不要求独立计数存储;一次成功回合后连续计数 SHALL 归零。

#### Scenario: 失败回合产出事件

- **WHEN** 某岗位的 cron 节奏回合因模型上游不可用而失败
- **THEN** 该岗位追加一条 status=failed、source=cron 的事件,errorKind=model_upstream,错误摘要与来源会话可查

#### Scenario: 被动岗唤醒回合产出事件

- **WHEN** 无节奏的被动岗因 delegation 唤醒执行了一回合并成功
- **THEN** 该岗位追加一条 source=delegation、status=ok 的事件,含起止时刻与执行模型

#### Scenario: errorKind 分类纯函数

- **WHEN** 分类函数收到「execution timed out」与一条无法识别的错误文本
- **THEN** 分别归类 timeout 与 other,过程不访问任何外部状态

#### Scenario: 非舰队回合零扰动

- **WHEN** 用户的一个普通定时任务(非舰队物化)执行并失败
- **THEN** 不产生任何回合结果事件

#### Scenario: 有界保留

- **WHEN** 某岗位累计事件超过保留上限
- **THEN** 最旧事件被裁剪,报数与拍板历史不受影响

#### Scenario: 连续失败聚合归零

- **WHEN** 某岗位连续 3 次失败后执行了一次成功回合
- **THEN** 该岗位连续失败计数从 3 归零,事件流保留全部 4 条记录

### Requirement: 回合结果事件可查询

系统 SHALL 提供回合结果事件的读面:成员级时间线(按岗位分页倒序,含 nextBefore 游标,同报数时间线形态)与舰队级过滤查询(按 status 与 source 过滤)。读面 SHALL 仅暴露事件字段,不携带凭据或会话正文;owner 作用域与舰队读面一致。

#### Scenario: 成员时间线分页

- **WHEN** 请求某岗位的回合时间线并传入上一页返回的 nextBefore
- **THEN** 返回更早一页事件,字段完整且无凭据与会话正文

#### Scenario: 舰队级失败过滤

- **WHEN** 请求舰队回合事件并指定 status=failed
- **THEN** 仅返回该舰队失败事件,含岗位标识与 errorKind
