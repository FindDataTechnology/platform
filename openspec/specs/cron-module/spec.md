## Purpose

Defines the in-cell scheduled-task engine: creating, persisting, and firing prompt jobs bound to a specific agent preset and session, with timezone-aware schedules and deterministic behavior around busy turns, runtime restarts, and downtime.

## Requirements

### Requirement: Job scheduling API
The system SHALL support three schedule forms for tasks whose trigger is a schedule: one-shot at an absolute time, one-shot at a relative delay from acceptance, and recurring either on a cron expression or on an every-N interval rule (number 1–200 × unit minute/hour/day/week). A recurring task MAY carry a maximum run count; on reaching it the task transitions to completed automatically. Each task carries a prompt and its target-persona/session binding. Management operations — list, remove, pause, resume, run-now, and **update** (change name/prompt/schedule/max-runs while preserving the task id, its execution history, and its paused state) — SHALL remain available over the existing cell WebSocket surface using the existing `cron_*` message and event types. Interval validation SHALL reject units outside the supported set with a structured error.

#### Scenario: Create a recurring job
- **WHEN** a client sends a job-create request with a cron expression and a prompt
- **THEN** the system SHALL create a task with a schedule trigger and broadcast its status with an identifier, schedule, and next-run time

#### Scenario: Create an interval job

- **WHEN** a client sends a job-create request with an interval rule (e.g. every 90 minutes) and a prompt
- **THEN** the system SHALL create a recurring task anchored at acceptance that fires at each elapsed period

#### Scenario: Interval unit outside the supported set is refused

- **WHEN** a client sends a job-create or update request with an interval unit of `month` or `year`
- **THEN** the system SHALL reject it with a structured validation error naming the supported units

#### Scenario: Create a one-shot job
- **WHEN** a client sends a job-create request with an absolute time and a prompt
- **THEN** the system SHALL create a task scheduled to run once at that time

#### Scenario: Pause and resume
- **WHEN** a task with a schedule trigger is paused
- **THEN** its schedule SHALL stop firing until it is resumed
- **AND** on resume a recurring task SHALL continue from the next future occurrence

#### Scenario: Run now
- **WHEN** a run-now request is sent for a task
- **THEN** the task SHALL execute once immediately regardless of its schedule, without affecting future scheduled occurrences

### Requirement: Jobs persist across restarts
All tasks with schedule triggers SHALL be persisted atomically with the engine's task records and restored when the cell starts, with recurring schedules rescheduled automatically; execution-level restart semantics (queued resumes, running becomes interrupted) are the engine's.

#### Scenario: Restore after restart
- **WHEN** the cell starts and persisted schedule-triggered tasks exist
- **THEN** enabled recurring schedules SHALL be rescheduled
- **AND** one-shot schedules whose time has not passed SHALL remain scheduled

#### Scenario: Atomic persistence
- **WHEN** a task or schedule mutation is persisted
- **THEN** the storage write SHALL be atomic, such that a crash mid-write cannot corrupt previously stored tasks

### Requirement: Schedules are timezone-aware
A job MAY carry an IANA timezone identifier. When present, its cron schedule SHALL be evaluated in that timezone. When absent, the schedule SHALL be evaluated in the cell's local timezone.

#### Scenario: User timezone applies
- **WHEN** a job is created with cron `0 9 * * *` and timezone `Asia/Shanghai` on a cell running in UTC
- **THEN** the job SHALL fire at 09:00 Asia/Shanghai time

#### Scenario: Legacy job falls back to cell timezone
- **WHEN** a persisted job carries no timezone
- **THEN** its schedule SHALL be evaluated in the cell's local timezone, matching pre-change behavior

### Requirement: Downtime and expiry lifecycle
Recurring schedules whose occurrences passed while the runtime was down SHALL follow the catch-up tolerance discipline: occurrences inside the tolerance window (2× period, 6-hour floor; kill switch `PLATFORM_CRON_CATCHUP`) SHALL be made up once with a make-up marker, and occurrences beyond the window SHALL NOT execute — the gap SHALL be recorded on the task as a missed record and surfaced through the explicit missed-beat alert (openspec: task-engine). One-shot schedules whose time passed while down SHALL mark their task expired at load. This discipline is the single authority for catch-up semantics; residency and wake surfaces (openspec: cell-gateway, cell-lifecycle) reference it and SHALL NOT redefine it.

#### Scenario: Missed occurrences are not replayed
- **WHEN** a daily task's cell was down longer than the catch-up tolerance window across one scheduled occurrence and starts afterwards
- **THEN** the missed occurrence SHALL NOT execute
- **AND** the task SHALL record a missed marker for it
- **AND** future occurrences SHALL fire normally

#### Scenario: Missed occurrence inside the tolerance window is made up once

- **WHEN** a daily task's cell was down briefly across one scheduled occurrence and starts afterwards
- **THEN** the occurrence SHALL be made up exactly once with a make-up marker
- **AND** future occurrences SHALL fire normally

#### Scenario: Missed occurrences beyond the tolerance window are recorded and alerted

- **WHEN** a task's cell was down longer than the tolerance window and occurrences were skipped
- **THEN** the skipped occurrences SHALL NOT execute
- **AND** the task SHALL record the miss and an explicit missed-beat alert SHALL be emitted naming the task and count
- **AND** future occurrences SHALL fire normally

#### Scenario: One-shot expired during downtime
- **WHEN** the cell starts and a one-shot task's time is in the past
- **THEN** the task SHALL be marked expired without executing

### Requirement: 舰队成员回合的子进程对话逐回合全新

舰队成员岗位（任务携带 fleetId——节奏触发、委托唤醒、事件唤醒同一执行缝；归属 SHALL 从 `sourceTag.fleetId` **或** `origin.fleet.fleetId` 任一取得，见下条）的
回合在设计上无状态：提示模板与舰队上下文（直属岗位末次报数、在岗总览）每回合现算注入，
历史对话对回合产出没有贡献。实现 SHALL 与该模型一致：每个舰队成员回合 SHALL 以**全新
的子进程对话**执行——运行时子进程 MUST NOT 回放此前回合的对话状态，回合启动 MUST NOT
因旧账压缩而显著劣化。子进程对话 id 与宿主专属会话（镜像）id 解耦：镜像 SHALL 维持单一
稳定会话、每回合转写行继续追加供人阅读，侧栏 SHALL NOT 因轮换出现每回合一个新会话；
子进程侧对话在回合收尾（子进程转闲）SHALL 获得 best-effort 清理，清理失败 MUST NOT
影响后续回合（后续回合的全新对话 id 不依赖清理成功）。不携带 fleetId sourceTag 的普通
定时任务 SHALL 维持既有「绑定会话续执行」语义，本需求不改变其行为。

#### Scenario: 舰队回合不续旧账

- WHEN 一个舰队成员岗位第 N+1 次节奏触发，第 N 回合及更早的转写已完整落盘
- THEN 本回合以全新子进程对话执行，子进程不回放第 N 回合及更早的历史
- AND 连续多回合执行中，回合启动耗时 SHALL NOT 随回合数增长而显著上升

#### Scenario: 镜像会话稳定可读

- WHEN 一个舰队成员岗位逐回合执行
- THEN 岗位专属会话保持单一镜像会话，每回合的用户提示与产出继续追加其中可读
- AND 会话列表不因子进程对话轮换而增加条目

#### Scenario: 子进程孤儿回收且失败无害

- WHEN 一个舰队成员回合收尾、子进程转闲
- THEN 平台对该回合的子进程对话发起 best-effort 清理
- WHEN 清理被运行时拒绝或不支持
- THEN 记一条警告日志，下一回合仍以全新对话 id 正常执行

#### Scenario: 普通定时任务语义不变

- WHEN 一个不携带 fleetId sourceTag 的普通定时任务触发
- THEN 其绑定会话的续执行语义与本 change 之前一致

#### Scenario: 历史任务的归属双源可判

- **WHEN** 一条舰队任务携带 `origin.fleet.fleetId` 而 `sourceTag` 为空（2026-10-24 前后的存量记录）
- **THEN** 该回合 SHALL 按舰队成员回合对待：轮换子进程对话 id、注入舰队上下文、适用早停与报数收尾判据

### Requirement: 模型车道按身份键控熔断与降级重试

模型车道 SHALL 以**车道身份**为熔断与降级的判定单元:车道 id SHALL 由该车道实际使用的 provider 派生(`providerId|baseURL|凭据指纹` 的哈希前缀,MUST NOT 含明文密钥)。当日 cell 内全部模型解析到同一 provider 时,行为自然退化为 cell 级;未来 per-agent/per-岗位 车道配置落地时,各车道 SHALL 自动获得独立熔断,本机制 MUST NOT 因车道拓扑变化而需要语义迁移。

熔断 SHALL 采用**连续失败计数(streak)**:该车道每记录一次模型上游失败 SHALL 使连续计数 +1——计数与失败之间的时间间隔无关,MUST NOT 依赖挂钟滑动窗攒阈值(无人值守回合 cadence 最小错峰 15 分钟、典型小时级,固定窗对全体 cadence 结构性无效,10-28→11-04 上游 5xx 风暴 94 条失败零 skipped 实证);连续计数达阈值(默认 5 次,可配)即开一段冷却期(默认 2 小时,可配),并提供总闸(默认开)。冷却期内触发的舰队成员回合 SHALL 被**跳过**而非失败——记 skipped 回合事件、不消耗模型预算、不计入岗位连续失败、且 skipped MUST NOT 触碰连续计数(开窗期内唯一恢复路径=冷却期满后的探针回合);车道出现任一成功 SHALL 立即清零计数并关闭熔断(半开探测即成功);冷却期满后探针再败 SHALL 因计数仍在阈值之上立即再开冷却期。熔断状态 SHALL 在管理面可见(车道 id、开窗截止时刻、连续失败计数)。

上游失败(5xx/连接类,快速失败)时,若该岗位模型解析链存在未试候选,SHALL 以下一候选模型**重试一次**(同回合内),并在回合 detail 记 `degradedTo`;重试仅限上游类失败且回合启动未超过短窗(默认 60 秒)——超时与工具类失败 SHALL NOT 触发重试。链上全部候选耗尽 SHALL 如实失败(链长 1 的岗位无跳可降=如实行为,非缺陷;想要换模型兜底 SHALL 通过给岗位/舰队配置 fallbackModel 解决,本机制对多跳链恒就绪)。

#### Scenario: 单车道退化为 cell 级

- **WHEN** cell 内全部岗位解析到同一 provider 且该车道累计连续 5 次上游 5xx(每次之间无任何成功、无论间隔数小时)
- **THEN** 该车道熔断开冷却期(默认 2h),期内节奏回合被跳过并记 skipped;冷却期满后的探针回合成功即清零关闸、恢复逐轮执行

#### Scenario: 滑窗式分布不豁免保护

- **WHEN** 某车道在 12 小时内每小时失败一次(共 12 次、中间无任何成功)
- **THEN** 第 5 次即开窗(滑动 10 分钟窗实现会全程漏判——本要求 MUST NOT 采用固定挂钟窗)

#### Scenario: 多车道各自独立

- **WHEN** 两个岗位分别配置不同 provider(key/baseURL 各异),车道 A 上游持续 5xx 而车道 B 正常
- **THEN** 仅车道 A 熔断;车道 B 的岗位回合照常执行,互不影响

#### Scenario: 成功即关闸

- **WHEN** 熔断开窗冷却结束后的第一个回合成功
- **THEN** 熔断关闭,连续计数清零

#### Scenario: skipped 不喂养计数

- **WHEN** 熔断开窗期内某岗位回合触发并被跳过
- **THEN** skipped 回合不产生成功也不计失败,连续计数与开窗截止均不被触碰;冷却期满仍回到探针

#### Scenario: 明文密钥不落日志

- **WHEN** 任意车道事件与熔断日志输出
- **THEN** 只出现车道 id 哈希前缀与 baseURL,不出现 key 材料

#### Scenario: 降级重试一次

- **WHEN** 岗位声明模型链 [A, B],回合以 A 启动后 20 秒收到上游 502
- **THEN** 本回合换 B 重试一次并继续完成;detail.degradedTo=B;若 B 也失败则回合如实失败

#### Scenario: 超时不触发重试

- **WHEN** 某回合因预算超时结束(非上游快速失败)
- **THEN** 不发生模型重试,回合按既有超时语义记 failed + detail 归因

### Requirement: Relative one-shots are anchored to the server's real clock
A create request carrying a relative delay SHALL be resolved by the server at acceptance time into an absolute run time computed from its own clock; the server SHALL NOT accept a client-computed wall time for the relative form, and SHALL reject delays that are not positive. The stored task SHALL carry the resolved absolute time so restart restores it unchanged.

#### Scenario: 「8 分钟后」 lands eight minutes out
- **WHEN** a client creates a one-shot with a 8-minute relative delay
- **THEN** the resolved run time is creation time + 8 minutes on the server clock, and the broadcast shows that absolute occurrence

#### Scenario: stale client cannot schedule in the past
- **WHEN** a client tries to express a one-shot for a moment that has already passed
- **THEN** the create is rejected with a structured error instead of silently deferring to a future date

### Requirement: Interval rules are the truth, human text is derived
For a recurring task on an every-N interval, the next occurrence SHALL be computed from the stored rule (anchor, unit, number, optional time-of-day phase), not from a coerced cron approximation. Unit/number combinations the five-field cron cannot express (e.g. every 40 days) SHALL be schedulable. Locale human-readable renderings are presentation only and MUST NOT feed back into scheduling math.

#### Scenario: every 40 days schedules correctly
- **WHEN** a task is created with interval unit=day, number=40
- **THEN** occurrences step 40 days apart from the anchor and the list renders a localized phrase without any cron coercion

### Requirement: Finite runs close themselves out
A recurring task with a maximum run count SHALL count completed scheduled executions (run-now and re-runs included as completed executions), transition to `completed` on reaching the cap, stop firing, and expose progress (executed/cap) on the task record.

#### Scenario: task retires at its cap
- **WHEN** the third run completes for a max-runs=3 recurring task
- **THEN** the task shows `completed`, no further occurrences fire, and history retains all three runs

### Requirement: Update preserves identity and history
An update changing the schedule SHALL recompute the next occurrence from the new form while keeping the task id, its execution history, and its paused state. An update MAY change name, prompt, schedule form, max-runs, and the target persona/session binding (re-binding detaches the old session attachment and attaches the new target while preserving history). Pause/resume is honored as-is.

#### Scenario: reschedule keeps the record
- **WHEN** a running-since-weeks daily job is updated to `0 10 * * 1-5`
- **THEN** the same id keeps its history rows and now fires weekday 10:00, unpaused if it was unpaused

#### Scenario: retarget keeps the record

- **WHEN** a task is updated to a different target persona
- **THEN** the same id keeps its history rows and future occurrences fire on the new target

### Requirement: 驻留回合的岗位持有自身 persona 的工具面

驻留（parked）回合的岗位 SHALL 以**该回合自身的目标 preset** 组合其工具面：其可用的
MCP server 与工具 allowlist SHALL 来自该 preset 自身的声明，SHALL NOT 来自运行时部署默认
preset 的组合。运行时部署默认 preset 不被定时车道移动这一纪律 SHALL 保持成立。

实现上 SHALL 以「按 preset 分段」的方式供给（每个已装 persona 一节精确面 + 一份并集上界），
SHALL NOT 通过「为每回合重写部署级 patch」实现——后者需要子进程重载，等于退回重启。

#### Scenario: 驻留岗位拿到自己的工具

- **WHEN** 一个 persona 岗位以驻留方式执行回合，其 pack 声明了若干 MCP server 与工具 allowlist
- **THEN** 该回合会话内可按工具检索命中该 pack 声明的工具，SHALL NOT 缺位

#### Scenario: 驻留岗位不被默认 persona 的面顶替

- **WHEN** 某 cell 的运行时部署默认 persona 声明了另一组 server 与工具
- **THEN** 驻留回合的工具面按该岗位自己的声明组合，不被默认 persona 的 allowlist 顶替

#### Scenario: 未声明 allowlist 的岗位按既有语义回落

- **WHEN** 某 persona 未声明自己的工具清单，但其所属 pack 在 pack 级声明了 allowTools
- **THEN** 该岗位的面按既有派生语义回落到 pack 级声明，SHALL NOT 凭空收窄或放大

#### Scenario: 默认 persona 不动仍成立

- **WHEN** 驻留回合执行前后
- **THEN** 运行时部署默认 preset 与其组合面保持回合前的值，用户对话车道不受影响

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

### Requirement: Catch-up window misses are alerted, not only recorded

The cron runner SHALL complement the existing tolerance-window catch-up (2× period, 6h floor, `PLATFORM_CRON_CATCHUP` kill switch) with an explicit alert when beats fall outside the window and are skipped. The alert SHALL name the job and the missed-beat count and ride the same alerting channel used by other platform components (metering explicit-alerting precedent). The existing record-only behavior for in-window catch-up is unchanged.

#### Scenario: Beats outside tolerance window surface as alerts

- **WHEN** a job's beats are skipped because the downtime exceeds the tolerance window
- **THEN** an alert event naming the job and missed count is emitted in addition to the per-task miss record

### Requirement: Fleet rounds skipped for missing registry listing are visible

When the fleet scheduler skips a pass because the registry listing fails, the skip SHALL be recorded with its reason on the run ledger (not only the log line), so skipped passes are countable and queryable like missed cron beats.

#### Scenario: Skipped fleet pass is countable

- **WHEN** a scheduled fleet pass is skipped due to a registry listing failure
- **THEN** the skip is recorded with the reason on the fleet run ledger and appears in the same query surface as executed rounds

### Requirement: 回合预算的解析结果即执行上界

任务引擎 SHALL 以一个可注入的解析器决定每次回合的时长上界，SHALL NOT 以固定常量替代已可解析的预算。
有解析器时，引擎交给回合执行器的上界 SHALL 等于解析器对该任务的返回值，且该值 SHALL 为非正有限数
（缺失、非法或解析失败 SHALL 落到默认值，SHALL NOT 传到执行器）。未注入解析器时，引擎 SHALL 使用
默认上界，其行为 SHALL 与变更前一致。

两个声明面同时存在时的优先级 SHALL 为：任务自带的边预算（`executionPolicy.timeoutMinutes`，按边）
优先于岗位声明（`cadence.turnTimeoutMs`，按岗），两者都缺省或用非法值时 SHALL 用默认上界。
边预算与岗位预算 SHALL 同样夹紧到 [2 分钟, 30 分钟]，越界 SHALL 取对应界值而非拒绝该回合。

#### Scenario: 岗位声明的预算真的到达回合

- **WHEN** 一个舰队岗位声明 turnTimeoutMs 为 20 分钟，其节奏回合被派发执行
- **THEN** 回合执行器收到的上界为 20 分钟，而非默认的 10 分钟

#### Scenario: 边预算优先于岗位预算

- **WHEN** 一个任务同时携带边预算 5 分钟（来自 orchestration constraints）与其岗位声明的 20 分钟
- **THEN** 该回合的上界为 5 分钟（边预算说话），岗位声明不覆盖它

#### Scenario: 未注入解析器时行为不变

- **WHEN** 引擎未注入预算解析器，任一任务被执行
- **THEN** 回合执行器收到的上界为默认 10 分钟，与变更前逐字节一致

#### Scenario: 解析失败不影响回合启动

- **WHEN** 预算解析器抛错或返回非法值（缺失、非数字、非正数）
- **THEN** 该回合以默认上界执行，不因预算解析失败而失败

#### Scenario: 越界预算取界后生效

- **WHEN** 边预算声明为 45 分钟（高于上界）
- **THEN** 该回合的上界为 30 分钟（上界夹紧）并照常执行
