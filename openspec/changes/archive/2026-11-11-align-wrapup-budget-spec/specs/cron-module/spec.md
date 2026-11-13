## MODIFIED Requirements

### Requirement: 舰队成员回合预算可按岗位声明

舰队成员岗位（任务携带 fleetId sourceTag）的单回合时长预算 SHALL 可按岗位声明：成员 cadence 的 `turnTimeoutMs` 字段在**界内值 [2 分钟, 30 分钟]** 时 SHALL 生效为该岗位每回合的回合预算（节奏触发、委托唤醒、事件唤醒同一执行缝一致）；越界值 SHALL 取对应界值（钳制，不拒绝、不报错）；未声明或非法值 SHALL 用默认 10 分钟——未声明岗位的系统行为 SHALL 与变更前逐字节一致。预算解析失败（成员行不可读等）SHALL 降级为默认值,SHALL NOT 影响回合启动。普通定时任务（无 fleetId sourceTag）SHALL 不受本字段影响。回合执行 SHALL 在检测到**压缩风暴**时提前停止：同一回合内 `compaction/start` 达硬阈值（默认 **4** 次——实测 5 次压缩的回合同样烧满 600 秒且无可恢复产出，故初稿的 6 次已下调）且已运行超过下限（默认 60 秒）时，系统 SHALL 原生取消该回合（`session/cancel`），并以上下文压力口径收口（与超时同类，走同一收尾补数车道）；该提前停止 SHALL 仅用于**舰队回合**——人类会话与普通定时任务 SHALL 保留完整预算。该提前停止 SHALL 在**所有执行车道**同等生效：串行链车道与 worker 池车道 MUST 使用同一策略与同一接线；任一车道缺少该策略、或未把启用标记交给回合收集器，SHALL 视为不满足本要求（2026-11-10 实证：worker 车道的启用标记曾被同仓重构整段删除，池开着时该车道跑满 600 秒而串行链照停，且无任何测试或类型报错）。开关 `FLEET_EARLY_STOP=0` SHALL 关闭该策略。判据为「继续跑也不会完成」，故最坏结果与原行为等价（仍按压力失败收口），最好结果 SHALL 提前释放串行槽。
回合收口 SHALL 区分「跑不完」与「上下文放不下」：同一回合内运行时压缩上下文（`compaction/start`）达到阈值（默认 2 次）而回合仍未收口时，超时归因 SHALL 标注 `contextPressure` 与压缩次数，错误文案 SHALL 指明上下文压力而非笼统超时。对**产出为空**且因上下文压力超时的舰队回合，系统 SHALL 在该回合失败收口后向同一子会话追加**一次**收尾询问（仅要求调用 `report_status` 交已有结论、明确拒绝其他工具，独立小预算默认 240 秒（实测调过：90 秒内多数压力回合来不及完成 report_status，补报形同虚设）；收尾结果 SHALL NOT 改变回合结论（回合仍记失败），SHALL 以 `detail.wrapUp` 记录是否补到内容。该收尾询问 SHALL NOT 用于：已有文本产出的回合、非舰队任务、因运行时中断（重启/中止）结束的回合、以及压缩次数未达阈值的超时。共享子进程上的凭据交付硬顶语义 SHALL 不变：其「不小于最长单回合预算」口径按本字段声明后的最坏值计。

#### Scenario: 慢上游岗位声明更长预算

- **WHEN** 提案岗 cadence 声明 turnTimeoutMs=1200000（20 分钟），回合内上游车道抖动重试至第 12 分钟仍在推进
- **THEN** 回合按 20 分钟预算继续执行,不出现 10 分钟 turn timed out

#### Scenario: 越界值取界

- **WHEN** 某岗位 cadence 声明 turnTimeoutMs=90000（1.5 分钟,低于下界）
- **THEN** 生效预算为 2 分钟（下界钳制）,回合照常执行

#### Scenario: 未声明岗位行为不变

- **WHEN** 舰队多数岗位未声明 turnTimeoutMs,其中一岗回合推进到第 10 分钟零 1 秒仍未收口
- **THEN** 该回合按既有口径记 turn timed out（默认 10 分钟）,行为与变更前一致

#### Scenario: 普通定时任务不受影响

- **WHEN** 不携带 fleetId sourceTag 的普通定时任务触发
- **THEN** 其回合预算语义与变更前一致（本字段不生效）

#### Scenario: 压缩风暴的超时点名上下文压力

- **WHEN** 某舰队回合在 10 分钟预算内发生 3 次上下文压缩仍未收口而超时
- **THEN** 该回合记 failed，detail 含 contextPressure 与 compactions=3，错误文案为「turn timed out — context pressure (3 compactions)」

#### Scenario: 空产出的压力回合补交报数

- **WHEN** 上述回合整轮没有任何文本产出
- **THEN** 系统向同一子会话追加一次收尾询问（240 秒预算、只允许 report_status），并把结果记入 detail.wrapUp；回合结论仍为 failed

#### Scenario: 有产出的回合不补收尾

- **WHEN** 某回合发生压缩风暴但已产出文本结论后超时
- **THEN** 不追加收尾询问（该文本已是本回合的答案），detail.wrapUp 不出现

#### Scenario: 中断与普通任务不补收尾

- **WHEN** 回合因运行时重启被中断，或无 fleetId 的普通任务因压缩风暴超时
- **THEN** 均不追加收尾询问，回合按既有语义收口

#### Scenario: 压缩风暴提前停止

- **WHEN** 某舰队回合已运行 90 秒且发生第 4 次 `compaction/start`
- **THEN** 系统原生取消该回合，以 `context pressure (4 compactions)` 收口并标记为提前停止，随后按既有判据尝试补交报数

#### Scenario: 人类会话不受影响

- **WHEN** 人类会话或普通定时任务在同一回合内发生多次压缩
- **THEN** 不发生提前停止，回合按原有预算运行

#### Scenario: 策略可关闭

- **WHEN** 部署设置 FLEET_EARLY_STOP=0
- **THEN** 提前停止不生效，舰队回合行为与引入本条款前一致

#### Scenario: 溢出失败带着撞墙现场

- **WHEN** 某舰队回合因 `context overflow` 失败
- **THEN** 该回合 `detail` SHALL 含 `lastInputTokens`（本回合见过的最大输入 token）、`contextWindow`（运行时实际解析到的窗口；未解析到 SHALL 为 `null`）、`steps` 与 `toolResults`
- **AND** SHALL NOT 用模型目录里的声明窗口冒充实际窗口

#### Scenario: 失败行不丢已观测到的用量

- **WHEN** 回合在抛错前已收到过至少一次 usage 快照
- **THEN** 该回合行 SHALL 带该快照（`usage` 非空），而不是全 `null`

#### Scenario: 接近窗口上限时提前收口（开关开启）

- **WHEN** 部署开启提前收口，且某回合内某一步的 `input + cacheRead` 达到解析窗口的 95%
- **THEN** 该回合 SHALL 以 `context_overflow` 收口并走同一条收尾补数车道，SHALL NOT 继续等到上游报错或回合预算耗尽

#### Scenario: 提前收口默认关闭

- **WHEN** 部署未开启该开关
- **THEN** 回合行为与本条款引入前逐字节一致（仅多记录 detail 证据）

#### Scenario: 收尾预算独立于回合预算

- **WHEN** 某岗位声明了 20 分钟回合预算，其压力回合触发了收尾询问
- **THEN** 收尾询问 SHALL 仍使用自己的 240 秒预算，SHALL NOT 继承该岗位的 20 分钟回合预算
- **AND** 该 240 秒 SHALL 计入槽位占用（收尾期间该槽位不接新回合）——这是本预算的已知代价
