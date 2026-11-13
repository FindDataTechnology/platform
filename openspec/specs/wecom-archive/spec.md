# wecom-archive Specification

## Purpose
把企业微信里**已经发生过的**会话，经官方「会话内容存档」取得、归一化、落库并可检索——以 5 天拉取窗口为
第一约束，以同意状态为第一字段，以"覆盖率可计算"代替"全量承诺"。

## Requirements

### Requirement: 会话内容存档以官方 SDK 拉取，游标与密钥由部署方持有

系统 SHALL 通过企业微信官方会话内容存档 SDK（`libWeWorkFinanceSdk_C`）逐 `seq` 拉取，单次 `limit`
不超过 1000 条；游标 `seq` SHALL 持久化，重启后从最后成功游标继续，MUST NOT 从 0 重放。
消息的 `encrypt_random_key` SHALL 由部署方持有的 RSA 私钥（PKCS#1 v1.5, 2048 位）解密后再交 SDK 解密。
私钥 MUST NOT 出现在仓库、镜像公开层或日志中。

#### Scenario: 重启后从最后游标继续

- **WHEN** 拉取器在 `seq=12345` 处被重启
- **THEN** 恢复后第一次拉取 SHALL 从 `seq=12345` 开始，MUST NOT 重新拉取更早的消息

#### Scenario: 单次拉取超限被拒

- **WHEN** 拉取请求的 `limit` 超过 1000
- **THEN** 系统 SHALL 以拉取失败处理并按 1000 重试，MUST NOT 把部分结果当作完整结果推进游标

#### Scenario: 私钥缺失时不静默降级

- **WHEN** 部署未提供 RSA 私钥
- **THEN** 通道 SHALL 以"未配置"状态拒绝启动拉取，并在巡检面给出明确原因，MUST NOT 以空结果冒充"无新消息"

### Requirement: 5 天拉取窗口是一等约束，滞后必须可见

腾讯仅保留 5 天会话内容。系统 SHALL 持续计算「当前时刻 − **最后一次成功拉取的时刻**」作为滞后，
并以它判定 `warn`（> 3 天）与 `lost`（> 5 天）。

水位 MUST 取「成功」的拉取：拉取**失败**不得推进水位（否则真断流会被显示成新鲜）；
拉取**成功但返回 0 条** MUST 推进水位（上游已答复"没有新的"，此时不得记为丢失）。

`lastCheckedAt`（最后一次尝试的时刻）SHALL 仅用于判定 `never_checked` 与 `stalled`，
MUST NOT 用作滞后水位——它在失败时也会推进，无法证明"拿到过"。

滞后超过 5 天 SHALL 标记为**不可恢复的数据丢失**并在巡检面持久呈现，MUST NOT 因后续拉取成功
而把该结论改写为"正常"。水位缺失时（例如老库刚升级）MUST NOT 判定为 `lost`，
SHALL 报 `never_checked` 并提示"尚未记录成功拉取"。

#### Scenario: 滞后 3 天告警

- **WHEN** 距最后一次成功拉取已 3 天以上且不足 5 天
- **THEN** 巡检面 SHALL 显示告警并给出当前滞后小时数

#### Scenario: 滞后超过 5 天记为永久丢失

- **WHEN** 距最后一次成功拉取超过 5 天
- **THEN** 系统 SHALL 记录一条不可恢复的丢失区间（起止时间、影响的席位范围），
  且该记录 MUST NOT 被后续成功拉取清除

#### Scenario: 安静但健康的通道不得记为丢失

- **WHEN** 某通道曾有消息，之后连续多日每轮拉取都成功、上游均返回 0 条
- **THEN** 滞后判定 MUST NOT 为 `lost`，丢失账本 MUST NOT 新增记录
- **AND** 判定依据 SHALL 是「距最后一次成功拉取」而非「距最后一条消息」

#### Scenario: 断流期间游标语义

- **WHEN** 连续多日拉取返回 0 条
- **THEN** 拉取器 SHALL 继续按周期推进「最后一次检查时间」并推进「最后一次成功拉取时刻」，
  MUST NOT 停止采样，也 MUST NOT 把"检查时间"当作"消息时间"

#### Scenario: 水位字段缺失时不得沿用旧口径

- **WHEN** 老库升级后尚未记录过任何成功拉取时刻
- **THEN** 滞后判定 SHALL 报 `never_checked` 并说明原因
- **AND** MUST NOT 依据最后一条消息时间判定 `lost`

### Requirement: 归一化以会话为主键，媒体与正文分离

系统 SHALL 以**会话**为主键存储：`conversation`（会话标识、类型、参与者、同意状态）、`message`
（消息 id、会话、时间、发送者、类型、正文引用）、`participant`、`media`（`sdkfileid`、类型、大小、完成状态）。
媒体 SHALL 按 `sdkfileid` 分块拉取（单次 512 KB，单块完成以 `is_finish` 判定）并与正文解耦：
媒体拉取失败 MUST NOT 回滚或阻塞正文入库。

#### Scenario: 媒体失败不影响正文

- **WHEN** 一条图片消息的媒体多次拉取失败
- **THEN** 正文记录 SHALL 正常入库，媒体记录 SHALL 标记失败原因并可重试，MUST NOT 使整条消息缺失

#### Scenario: 会话标识用于归属判定

- **WHEN** 收到一条群聊消息
- **THEN** 系统 SHALL 以会话（`chatid`）而非单条消息作为同意状态、覆盖率与去重的归属单位

### Requirement: 同意状态是一等字段，拒绝即不落库

系统 SHALL 通过官方 `check_single_agree` / `check_room_agree` 取得 `agree_status`，并作为消息入库前的
前置条件。`agree_status=Disagree` 的会话，其消息 MUST NOT 入库（不得先落库再标记删除）。
系统 MUST NOT 推断、补齐或默认同意；同意状态变更 SHALL 通过官方回调或重新查询获得。

#### Scenario: 外部客户拒绝后消息不入库

- **WHEN** 某外部客户对当前会话选择不同意存档
- **THEN** 该会话的消息 SHALL NOT 出现在库中，且 SHALL NOT 出现在任何查询面

#### Scenario: 同意后开始入库

- **WHEN** 某外部客户对当前会话选择同意
- **THEN** 自该时点起的消息 SHALL 入库；此前未同意的区间 MUST NOT 被回溯补齐

### Requirement: 本方发言必须可识别，防止自问自答闭环

每条入库消息 SHALL 带 `origin` 区分本方与对方（含 bot 自身发出的回复）。任何把存档内容送入 agent 回合的
消费方 SHALL 依据 `origin` 丢弃本方消息，MUST NOT 把本方回复当作新的用户输入。

#### Scenario: 自身回复不被当成客户输入

- **WHEN** 存档中出现一条由本方员工或 bot 发出的消息
- **THEN** 以存档为输入的 agent 回合 SHALL NOT 因该消息而启动

#### Scenario: bot 回复的归并幂等

- **WHEN** 同一条 bot 回复既出现在 bot 回调流里、又出现在存档里
- **THEN** 归并后 SHALL 只保留一条，且 MUST NOT 因两侧 `msgid` 不同而重复入库

### Requirement: 覆盖率以生效席位与会话数计算，禁止宣称全量

系统 SHALL 报告覆盖率口径为：`生效席位数`、`有消息的会话数`、`同意会话占比`、`未覆盖原因分布`。
系统 MUST NOT 对外声明"获取全部企业微信会话"——未开启存档的两名成员之间的会话，官方不可获取。
接口返回的生效席位可能少于购买席位数时，SHALL 以生效席位为准并提示差异。

#### Scenario: 未开启成员之间的会话不可得

- **WHEN** 两名成员均未纳入存档范围，且他们互相私聊
- **THEN** 该会话 MUST NOT 出现在库中，且查询面 SHALL NOT 将其计为"缺失"

#### Scenario: 购席与生效席位不一致时如实呈现

- **WHEN** 购买席位数大于接口返回的生效成员数
- **THEN** 巡检面 SHALL 显示两个数字及差值，MUST NOT 以购买数作为覆盖口径

### Requirement: 与 bot 车道并存，边界不得互相渗透

bot 车道维持既有语义：仅在成员 @机器人 或单聊时收到消息，且 MUST NOT 越权订阅群消息。
整群消息的唯一来源是会话存档，并受本规格的授权与同意约束。两侧对同一会话的视角 SHALL 按
`msgid` + 时间 + 发送者归并，规则固定且可测。

#### Scenario: bot 车道不因存档上线而扩容权限

- **WHEN** 会话存档通道已启用
- **THEN** bot 回调的投递范围 SHALL 保持不变，MUST NOT 因存档存在而开始接收未 @ 的群消息

#### Scenario: 两个视角归并为一条时间线

- **WHEN** 同一会话既有 bot 实时产生的消息，也有存档回溯的历史
- **THEN** 查询面 SHALL 返回单一按时间排序的时间线，且同一消息 MUST NOT 出现两次

### Requirement: 拉取出口必须固定且可声明

会话存档拉取受企业微信「可信 IP」白名单约束。部署形态 SHALL 提供稳定出口 IP，并把该 IP 作为配置项声明；
系统 MUST NOT 依赖会漂移的运行时地址发起拉取。

#### Scenario: 出口不在白名单时给出可判读的失败

- **WHEN** 拉取返回 `errcode=301042`
- **THEN** 系统 SHALL 报告"出口 IP 不在可信列表"并给出当前出口 IP，MUST NOT 归类为网络故障或上游异常

### Requirement: 撤回同意必须在平台内即刻生效，不得等缓存过期

平台部署形态下，企微推送的同意变更事件（`MsgType=event`、`Event=msg_audit_approved`）SHALL 经既有的验签入口被消费：验签通过后 SHALL 写入跨进程的同意变更水位，使拉取侧下一次决策 MUST NOT 继续沿用事件之前的同意结论。

事件消费 SHALL 只作废旧结论，MUST NOT 在该路径上直接出网重查同意接口——重试风暴时会把一条回调放大成一次外部请求，且查证职责本就属于拉取侧。

事件不属于会话内容：MUST NOT 被当作一条待回复的消息进入消息管线，MUST NOT 占用消息去重键或触发 agent 回合。

存档侧的任何失败（库不可用、报文读不懂、schema 异常）MUST NOT 使验签入口返回非 2xx：平台对非 2xx 会重试，重试并不能让库变成可写，只会把故障窗口拉长并拖累共用同一入口的其他车道。失败 SHALL 以日志呈现，MUST NOT 静默。

未配置存档库位置时整条事件路径 SHALL no-op，且 MUST NOT 因此创建库文件。

#### Scenario: 客户撤回同意后不再入库

- **WHEN** 某会话此前为同意、客户在微信里改为不同意，企微把 `msg_audit_approved` 推到应用的接收消息 URL
- **THEN** 回调经验签后被消费，跨进程水位被写入；拉取侧此前的同意缓存因水位更新而作废，新消息 MUST NOT 入库

#### Scenario: 事件不被当成消息

- **WHEN** 一条 `MsgType=event` 的回调到达验签入口
- **THEN** 它不进入消息去重存储、不启动任何 agent 回合，且入口回 200

#### Scenario: 存档侧故障不得外溢

- **WHEN** 同意变更事件已验签通过，但存档库不可写
- **THEN** 验签入口仍回 200 并记下失败原因；同一入口上的文本消息路径行为不变

#### Scenario: 共用回调 URL 上的其它事件无副作用

- **WHEN** 同一接收消息 URL 收到 `enter_agent` 之类与同意无关的事件
- **THEN** 不写水位、不改任何会话的同意状态，也不因此报错

#### Scenario: 未配置存档库时不落任何痕迹

- **WHEN** 部署未配置存档库位置，而回调里出现了同意变更事件
- **THEN** 事件路径 no-op、入口回 200，且不产生新的库文件或目录
