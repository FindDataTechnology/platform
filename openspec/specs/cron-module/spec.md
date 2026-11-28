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

A timezone supplied by a caller SHALL be validated against the zone database that the scheduler itself uses, at the moment it is accepted, and SHALL be rejected with a structured error when it is not resolvable as an IANA identifier. Validation SHALL hold on **every write face** — creating a job and editing an existing job — and SHALL NOT depend on the caller also supplying a cron expression in the same request: an edit that changes only the timezone SHALL be validated exactly like one that changes both, and a rejected value SHALL leave the stored timezone unchanged.

When a write is rejected because the timezone is unresolvable, the error SHALL name the timezone as the cause; it SHALL NOT be reported as an invalid cron expression, because in that case the expression was never the problem.

Existing jobs that already carry an unresolvable timezone SHALL NOT be rewritten by this validation; they remain readable and are repaired only through a subsequent accepted edit.

#### Scenario: User timezone applies
- **WHEN** a job is created with cron `0 9 * * *` and timezone `Asia/Shanghai` on a cell running in UTC
- **THEN** the job SHALL fire at 09:00 Asia/Shanghai time

#### Scenario: Legacy job falls back to cell timezone
- **WHEN** a persisted job carries no timezone
- **THEN** its schedule SHALL be evaluated in the cell's local timezone, matching pre-change behavior

#### Scenario: Unresolvable timezone is rejected on create
- **WHEN** a job is created with a timezone that is not a resolvable IANA identifier (for example `Shanghai`, whose IANA name is `Asia/Shanghai`)
- **THEN** the request SHALL be rejected, the error SHALL name the timezone as the cause, and no job SHALL be stored

#### Scenario: Timezone-only edit is validated too
- **WHEN** an existing job is edited with only a timezone and no cron expression, and that timezone is not resolvable
- **THEN** the request SHALL be rejected and the job's stored timezone SHALL remain unchanged

#### Scenario: Valid timezone-only edit still applies
- **WHEN** an existing job is edited with only `Asia/Shanghai` and no cron expression
- **THEN** the job SHALL store that timezone and SHALL keep its existing cron expression unchanged

#### Scenario: A rejected timezone leaves a working schedule working
- **WHEN** a job whose schedule currently fires is edited with an unresolvable timezone
- **THEN** the edit SHALL be rejected and the job SHALL keep firing on its existing timezone

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

This SHALL hold for **every recurring form** — an every-N interval rule and a cron expression alike. The cap is declared on the task, and creation accepts it for both forms, so an accepted cap that is never counted for one of those forms is a declaration silently ignored; that state SHALL NOT exist. Re-arming after a counted round SHALL remain the interval path's business only: a cron handle repeats by itself, and re-arming it here would create a second timer for one task.

A task that declares no cap SHALL NOT have its run counter advanced, so its persisted shape is unchanged by this rule.

The run counter SHALL NOT be reconstructed from execution history: a history row does not establish the counter's prior value, and seeding it could retire a task that never actually completed its declared number of rounds.

Once a task reaches its cap, its `completed` status is a designed terminal state alongside `expired` — read surfaces and health judgements SHALL treat it as finished rather than as a schedule that failed to run.

#### Scenario: task retires at its cap
- **WHEN** the third run completes for a max-runs=3 recurring task
- **THEN** the task shows `completed`, no further occurrences fire, and history retains all three runs

#### Scenario: Capped cron task retires at its cap
- **WHEN** a cron task declares a maximum of two runs and completes its second round
- **THEN** its run counter is 2, the task shows `completed`, its timer is cancelled, no next occurrence is exposed, and a further round does not start

#### Scenario: Capped cron task keeps firing below its cap
- **WHEN** a cron task declares a maximum of two runs and completes its first round
- **THEN** the task stays armed on its existing handle with exactly one timer, and its run counter is 1

#### Scenario: Uncapped task keeps its counter untouched
- **WHEN** a recurring task declares no maximum run count and completes a round
- **THEN** its run counter is not advanced and it remains armed as before

#### Scenario: Completed is not a failing schedule
- **WHEN** a task holds `completed` after reaching its cap, including when its final round ended in failure
- **THEN** read surfaces and health judgements report it as a designed terminal state, not as a schedule that failed to run

### Requirement: Update preserves identity and history

An update changing the schedule SHALL recompute the next occurrence from the new form while keeping the task id, its execution history, and its paused state. An update MAY change name, prompt, schedule form, max-runs, and the target persona/session binding (re-binding detaches the old session attachment and attaches the new target while preserving history). Pause/resume is honored as-is.

An update that changes the schedule form SHALL replace the previous form, never shadow it. A stored task SHALL NOT carry two scheduling forms at once (a cron expression together with an interval rule and its anchor, or either with a one-shot time), because creating such a shape is rejected — and the scheduler consults the interval rule before the cron expression, so a surviving old form keeps firing while the record, and every list view that renders it, reports the new one. The form a task reports SHALL be the form that fires.

An update SHALL produce a record that creation would also accept. Every cross-field constraint creation enforces SHALL hold on the edit face as well, judged on the prospective record rather than on the fields the request happened to carry: a tool target's prompt MUST parse as a JSON object, a run cap MUST sit on a recurring form, and the relative-delay form MUST NOT be combined with an absolute time. A constraint SHALL be judged only when the part it governs is being changed, so an unrelated edit never rejects a legacy record.

All validation SHALL complete before the stored record is touched. A rejected update SHALL leave every stored field at its previous value — not only on disk, but in memory, because the record is mutated in place and a later unrelated save would otherwise persist the rejected value.

#### Scenario: reschedule keeps the record
- **WHEN** a running-since-weeks daily job is updated to `0 10 * * 1-5`
- **THEN** the same id keeps its history rows and now fires weekday 10:00, unpaused if it was unpaused

#### Scenario: retarget keeps the record
- **WHEN** a task is updated to a different target persona
- **THEN** the same id keeps its history rows and future occurrences fire on the new target

#### Scenario: interval task switched to a cron expression fires on the expression
- **WHEN** a task created as an every-40-days interval is updated to the cron expression `0 9 * * *`
- **THEN** the stored task carries the cron form only, its next occurrence follows that expression (within a day, not forty), and the dropped interval rule no longer influences firing

#### Scenario: interval task switched to an absolute time becomes a one-shot
- **WHEN** a task created as an every-N-days interval is updated with an absolute `when`
- **THEN** the task is a one-shot, the interval rule and its anchor are gone, and the next occurrence is that exact time

#### Scenario: an updated record is a shape creation would accept
- **WHEN** any in-place update changes the schedule form
- **THEN** the resulting stored task never carries both a cron expression and an interval rule, matching the exclusivity creation enforces

#### Scenario: an unrelated edit leaves the armed occurrence alone
- **WHEN** an interval task is updated with only a prompt change
- **THEN** its interval rule and its already-armed next occurrence are unchanged

#### Scenario: a tool task's prompt cannot be edited into a non-JSON string
- **WHEN** an existing tool-targeted task is updated with a prompt that is not a JSON object
- **THEN** the update is rejected with an error naming the JSON object requirement, and the stored prompt keeps its previous value in memory as well as on disk

#### Scenario: a tool task's prompt can still be edited to another JSON object
- **WHEN** an existing tool-targeted task is updated with a different JSON object as its prompt
- **THEN** the update is accepted and the new arguments are stored

#### Scenario: a run cap cannot be placed on a non-repeating task
- **WHEN** a one-shot task is updated with a maximum run count
- **THEN** the update is rejected because no recurring form is present, and the record keeps no cap

#### Scenario: a recurring task can be given a cap in place
- **WHEN** a recurring task without a cap is updated with a maximum run count
- **THEN** the cap is stored and its executed counter starts at zero

#### Scenario: a relative delay cannot be combined with an absolute time
- **WHEN** an update supplies both a relative delay and an absolute `when`
- **THEN** the update is rejected as exclusive, rather than silently keeping one and dropping the other

#### Scenario: a rejected update leaves the live record untouched
- **WHEN** any update is rejected by a cross-field check
- **THEN** every field of the in-memory record still holds its previous value, so a later unrelated save cannot persist the rejected edit

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

### Requirement: A round stopped early says why it stopped

An execution record SHALL carry the executor's own verdict when a round was stopped before it could finish, whenever the executor declared one. A round stopped by the budget soft stop SHALL be recorded with a machine-readable soft-stop marker beside its failure state and its message; it SHALL NOT be indistinguishable from a round that failed on its own. The same rule applies to any other early stop the executor names (platform-skipped rounds already carry `skippedReason`; a round stopped for context pressure carries its own marker).

The marker SHALL be taken from the executor's structured verdict, not inferred from the human-readable message text, and SHALL survive persistence: the stored record read after a restart SHALL carry it.

Decisions that follow from a stop reason SHALL also read the structured verdict, with text matching only as a fallback for paths that carry no structure. In particular, deciding that the next round must start a fresh session SHALL be driven by the executor's overflow verdict, and SHALL NOT depend on the wording of the error message; a message-only overflow SHALL still be honoured, because some paths report nothing but text.

The two pressure verdicts SHALL NOT be conflated: a round that exhausted its context window and a round that compacted too often both count as pressure, but only the former means the session must be replaced.

Recording a stop reason SHALL NOT change the success/failure verdict of the round: a soft-stopped round is still not a success, because it did not finish.

#### Scenario: a soft-stopped round carries the marker
- **WHEN** a fleet round is stopped at the budget soft-stop threshold
- **THEN** its execution record carries the failure state, the message naming the stop, and the soft-stop marker

#### Scenario: the marker survives persistence
- **WHEN** the task store is written after a soft-stopped round
- **THEN** the stored execution record carries the marker, so a reader after a restart still knows why the round stopped

#### Scenario: a round that failed on its own carries no marker
- **WHEN** a round fails with an ordinary error (upstream connection loss, timeout)
- **THEN** its execution record carries no soft-stop marker

#### Scenario: the marker does not depend on the message wording
- **WHEN** the executor declares a soft stop but its message text does not name it
- **THEN** the record still carries the marker

#### Scenario: a successful round carries no marker
- **WHEN** a round completes normally
- **THEN** its execution record carries no soft-stop marker and its success verdict is unchanged

#### Scenario: a structured overflow verdict replaces the session even when the text is silent
- **WHEN** the executor reports an overflow verdict and the error message contains none of the words the text matcher looks for
- **THEN** the next round starts on a fresh session

#### Scenario: a message-only overflow still replaces the session
- **WHEN** a failing round reports an overflow only through its message text, with no structured verdict
- **THEN** the next round still starts on a fresh session

#### Scenario: compaction pressure alone does not replace the session
- **WHEN** a round stops because it compacted too often without exhausting its context window
- **THEN** the next round keeps its existing session, while the record still notes the pressure

### Requirement: A task whose schedule cannot produce a next occurrence SHALL arm visibly broken

When the scheduler arms a task and no next invocation can be produced (for example a timezone that cannot be resolved), the task SHALL be marked `status:"error"` with an error naming the unresolvable value and persisted with the task record. It SHALL NOT remain in the state that reads as normally scheduled while it will never fire.

A task that is paused SHALL NOT be flagged by this check: not running is the owner's intent, and the check SHALL apply only where an arm was actually attempted.

#### Scenario: A legacy task with an unresolvable timezone becomes visibly broken at boot

- **WHEN** the store contains a recurring task with `tz:"Shanghai"` (not an IANA name) and the runtime boots
- **THEN** that task's status SHALL become `"error"` with an error message naming the timezone and stating the task would never fire, and the persisted store SHALL carry that status and message

#### Scenario: A valid timezone still arms normally

- **WHEN** a recurring task carries a resolvable timezone (e.g. `Asia/Shanghai`) and the runtime boots
- **THEN** the task SHALL remain `"scheduled"` with a non-empty next run

#### Scenario: A paused task is not flagged

- **WHEN** a recurring task with an unresolvable timezone is paused and the runtime boots
- **THEN** the task SHALL keep its paused state and SHALL NOT be marked as an error

### Requirement: 工具形状的 preset 在两个绑定入口都被拒

`cron.js` SHALL 在 `tool` 未给出时拒绝形如 `server::tool` 的 `preset`（字符串含 `::`），并 SHALL 对**创建**（`addJob`）与**改绑**（`updateJob`）两个入口施加同一份判据；SHALL NOT 把它静默归成 `persona` 目标。

- 两份判据 SHALL 是同一段代码（一个函数、两处调用），SHALL NOT 各写一份——创建面校死而编辑面绕过，正是这一族缺陷的常态。
- 判据 SHALL 只依赖 `::` 这一条硬事实：运行期 roster 的 persona id 只允许 `[a-z0-9-]`，`::` 在 persona id 里不是合法字符，因此不会误伤真实岗位（含点号形式的用户预设 id）。
- 拒绝 SHALL 发生在绑定那一刻，SHALL NOT 留到执行期（执行期只有一条 `Unknown agent preset: <id>`，与「这个岗位被停用了」逐字同形，读不出真因）。
- 错误文案 SHALL 点名该值并给出修法：工具引用要传 `tool` 而不是 `preset`，`prompt` 是工具的 JSON 参数。
- `tool` 已给出的路径 SHALL 保持现状：`targetType` 为 `tool`，`prompt` 必须是 JSON 对象；集群岗（`clusterId`）与 a2a（`agent`）SHALL NOT 受本判据影响。
- 一条已被拒绝的改绑 SHALL NOT 改动既有记录（判据在写入前生效）。

#### Scenario: 创建时 preset 写成工具引用且没带 tool

- **WHEN** 调用方以 `preset: "websearch::web_search"` 创建作业，且未给出 `tool`
- **THEN** 创建请求以结构化错误被拒
- **AND** 错误文案点名 `websearch::web_search` 并说明「工具引用应传 `tool`，`prompt` 是它的 JSON 参数」
- **AND** 平台不创建任何作业

#### Scenario: 改绑时把健康作业改成工具形状

- **WHEN** 对一条既有的 persona 作业调用 `updateJob`，只传 `preset: "websearch::web_search"`（不带 `tool`）
- **THEN** 改绑被拒，错误与创建面同形
- **AND** 既有记录保持原样（`preset` 与 `targetType` 都不变）
- **AND** 正确的改绑写法（传 `tool` 与 JSON `prompt`）照常生效，`targetType` 变为 `tool`

#### Scenario: 普通 id 与非 persona 目标不被误伤

- **WHEN** 调用方用 `preset: "policy-brief"` 或点号形式的 `user.preset-7`，或用 `agent` / `clusterId` 绑定
- **THEN** 与今天行为逐字相同，不新增任何拒绝

### Requirement: 预算到期前的软停与补交报数

舰队回合 SHALL 在有效预算的一个比例处软停，把剩余预算让给收尾车道，而不是烧满整段预算后空手失败。

- 软停点 SHALL 为 `有效预算 × 软停比率`，比率默认 **0.8**，可由岗位 `cadence.softStopRatio` 覆盖（界内 [0.5, 0.95]，越界/非法取默认）。
- 软停 SHALL 原生取消该回合（`session/cancel`，与压缩风暴早停同一通道），并以「预算软停」口径收口：该回合记 failed，detail SHALL 含 `budgetSoftStop: true`、`elapsedMs`、`steps`。
- 收尾询问（salvage）的判据 SHALL 为「舰队回合 ∧ 未交报告（`reported !== true`）∧ 未被中断」，SHALL NOT 再以「上下文压力」为前置条件——软停型与压力型 SHALL 走同一车道。
- 软停 SHALL 只作用于舰队回合：人类会话与无 fleetId 的普通定时任务 SHALL 保留完整预算。
- 软停 SHALL 在串行链与 worker 池两条车道同等生效；任一车道缺少软停 SHALL 视为不满足本要求。
- `FLEET_BUDGET_SOFT_STOP=0` SHALL 关闭软停；关闭后行为 SHALL 与变更前逐字节一致。
- 有效预算的解析口径 SHALL 不变（`executionPolicy.timeoutMinutes` > `cadence.turnTimeoutMs` > 10 分钟，clamp [2,30] 分钟）；软停比率 SHALL NOT 引入新的预算来源。

#### Scenario: 多步回合在软停点让出槽位并补交报数

- **WHEN** 某舰队回合使用 10 分钟默认预算，已跑 10 步工具调用且仍无收口迹象，到达 480 秒
- **THEN** 系统原生取消该回合，detail 含 `budgetSoftStop: true` 与 `steps: 10`
- **AND** 随后向同一子会话追加一次收尾询问（只允许 `report_status`，独立预算）
- **AND** 该轮结论仍为 failed，`detail.wrapUp` 记录是否补到内容

#### Scenario: 已交报告的回合不补收尾

- **WHEN** 软停发生时该回合已经调用过 `report_status`
- **THEN** 不追加收尾询问

#### Scenario: 人类会话与普通任务不软停

- **WHEN** 一轮是用户与平台的对话，或不携带 fleetId 的普通定时任务
- **THEN** 不设软停点，回合按完整预算执行

#### Scenario: 软停可声明可关闭

- **WHEN** 岗位声明 `cadence.softStopRatio = 0.6`，或部署设置 `FLEET_BUDGET_SOFT_STOP=0`
- **THEN** 前者软停点变为预算的 60%；后者完全不软停，行为与变更前一致

#### Scenario: 越界比率取默认

- **WHEN** 岗位声明 `cadence.softStopRatio = 0.1`（低于下界 0.5）
- **THEN** 软停比率取默认 0.8

### Requirement: 轮换效果与累积人口必须能由一条只读读数复算

系统 SHALL 提供一个只读读数（`scripts/cron-session-metrics.mjs`），一次给出**三项必须一起读**的量，
使「轮换在防什么、它防的事有没有人口」这个问题不依赖任何人的一次性手工探针：

1. **会话长度分布**——每个 session 的 cron 回合数（p50/p90/max 与分桶直方）；
2. **会话内累积斜率**——`(末轮 - 首轮) / (轮数 - 1)` 的分位，SHALL 允许为负；
3. **到线人口**——多轮会话里峰值达到轮换门槛与模型窗口的会话数。

口径 SHALL 固定为：高水位取 `member_turn_events.usage_input_max`（每请求 prompt 高水位，
与 `contextWindow` 可比的量），单步分量（`usage_input` / `usage_cached_input`）SHALL NOT 相加冒充
prompt；时间一律按 `started_at`（epoch 毫秒整数）。

读数 SHALL 点名数据覆盖（cell 数、可读行数、时间窗）与每一类跳过（无库 / 无表 / 无 store）；
读不到任何数据时 SHALL 以「判不出」退出（非零），SHALL NOT 报 0 条或 0%。

轮换归因 SHALL 按在役判定代码的**三条**路径分开计数（上一轮失败 / 上一轮溢出 / 阈值），
并把事后数据解释不了的轮换**单列**；SHALL NOT 把它并进任何一档。

该读数 SHALL NOT 给出红绿判定：它量的是人口与斜率，判定归具体 change 的解锁条件。

#### Scenario: 三项一起给出，并点名覆盖与窗口

- **WHEN** 对一个含多个 cell 的根目录运行读数
- **THEN** 输出含会话长度分布、会话内累积斜率、到线人口三节
- **AND** 同时点名 cell 总数、可读行数、时间窗起止，以及无库 / 无表 / 无 store 各多少

#### Scenario: 读不到数据时判不出，不报 0

- **WHEN** 根目录下没有任何可读的 `member_turn_events` 或 `jobs.json`
- **THEN** 命令以非零退出并说明「判不出」及各类跳过计数
- **AND** SHALL NOT 输出「0 个会话」「0 轮」这类会被读成「测过了、确实是空的」的读数

#### Scenario: 到线人口的分母只算多轮会话

- **WHEN** 统计峰值达到门槛的会话数
- **THEN** 分母只包含回合数 ≥2 的会话
- **AND** 单轮会话只进长度分布，SHALL NOT 进到线人口的分母（否则占比被稀释成「看起来没事」）

#### Scenario: 累积斜率为负时如实报负

- **WHEN** 某会话的末轮高水位低于首轮
- **THEN** 该会话的斜率计入样本且为负值
- **AND** SHALL NOT 抹成 0（抹零会让「不累积」看起来像「缓慢累积」，两者对轮换的结论相反）

#### Scenario: 轮换归因三条路径分开、解释不了的单列

- **WHEN** 归因一批带 `sessionRotated` 的执行行
- **THEN** 计数分别落到「上一轮失败」「上一轮溢出」「阈值」「首行」四档
- **AND** 上一轮成功而闸判不用换、却仍发生轮换的行 SHALL 计入「解释不了」并附样例 job 名，
  而 SHALL NOT 被并进「上一轮失败」或「阈值」

#### Scenario: 分母是执行行，不是任务数也不是全部历史行

- **WHEN** 计算轮换率
- **THEN** 分子分母都只数 `kind === "execution"` 的行
- **AND** `missed` / `skipped` 行 SHALL NOT 参与（降载记账与跳过不是回合，没有轮换语义）

#### Scenario: 不出红绿

- **WHEN** 读数的任何一节出现「看起来不妙」的数字
- **THEN** 命令仍以 0 退出并只打印事实
- **AND** SHALL NOT 以退出码表达判断（该判断属于具体 change 的解锁条件，不属于这个读数）

### Requirement: 定时回合的历史行必须带出本轮的上下文占用与运行时窗口

每个 cron 回合结束时，其历史行 SHALL 记录该回合出现过的**最大 prompt 占用**（`inputTokens +
cacheReadTokens` 的高水位，字段名 `promptTokens`）与**运行时为该请求解析出的模型窗口**
（`request/context` 的 `contextWindow`）。两者任一不可得时 SHALL 省略该字段，
SHALL NOT 以部署常量、`0` 或其它推算值顶替。

取值 SHALL 同时覆盖成功与失败两种收尾形态：成功回合这两个数在回合结果的顶层，失败回合只在
`detail` 里（`timeoutError` / `markPartialUsage` 写入），历史行 SHALL 从两者中取可用的那个；
顶层可用时 SHALL 以顶层为准，SHALL NOT 混取两个来源拼出一对数。

读面 SHALL 能仅凭这两个数算出「该回合结束时会话占窗口的比例」，使「这个岗位的会话已经
接近满」在回合失败之前可见——而不是只在溢出/超时的失败 detail 里才第一次出现。

字段语义按此固定：`promptTokens` 是 provider 被计费的**整个** prompt；历史行 `tokens` 内的
`inputTokens` 是其中**未命中缓存**的那一部分，两者相差 `cacheReadTokens`，不得互相替代。

#### Scenario: 成功回合也带出占用

- **WHEN** 一个 cron 回合正常结束（成功），且该回合的 collector 既量到了 prompt 高水位、运行时也发出了 `request/context` 的窗口
- **THEN** 其历史行同时含 `promptTokens` 与 `promptWindow`，读面可由两者算出比例

#### Scenario: 运行时没解析出窗口时省略，不拿常量顶替

- **WHEN** 某回合的运行时始终没有发出带 `contextWindow` 的 `request/context`
- **THEN** 该历史行不含 `promptWindow`（也不含由常量推算出的比例），读面显示「未知」而不是一个假的百分比

#### Scenario: 没有计量时不留 0

- **WHEN** 某回合的 provider 没有报告任何 usage（`promptTokens` 为 0 或缺失）
- **THEN** 该历史行不含 `promptTokens`，读面 SHALL NOT 显示 `0%`——`0` 会被读成「空会话」，而真相是「不知道」

#### Scenario: 失败回合也带出占用

- **WHEN** 某回合因上下文溢出被提前中止，两个数只出现在回合结果的 `detail` 里
- **THEN** 其历史行仍带出 `promptTokens` 与 `promptWindow`——「死在 97%」正是最该留下证据的那一轮

#### Scenario: 读面按任务显示占比

- **WHEN** 运维读取任务列表，其中某任务最新回合的历史行两个数齐全
- **THEN** 该行带出占比读数（形如 `session 83% of 128000`）
- **AND** 两数不全的任务不带出占比读数，SHALL NOT 显示 `0%` 或 `unknown%`

### Requirement: 会话轮换的触发只认真执行过的回合

定时任务在开跑前决定是否换会话时，判据 SHALL 按 `history[]` 条目的**类型**分流，SHALL NOT 按 `success` 的原始形状猜测：

- 「上一轮失败」SHALL 仅在上一行 `kind` 为 `execution`（旧数据按 `state` 落在 done/failed/interrupted/skipped 回退识别）且 `success !== true` 时成立；
- `missed`（排期到了但从未开始）、`superseded`（被同岗位新一轮顶替）、`queued-upgrade` 与 `meta`（元数据留痕）SHALL NOT 触发轮换——它们没有失败的子进程，也没有值得丢弃的上下文；
- 另外两个触发条件（worker 车道的溢出标记 `rotateNextSession`、最新计量回合的 token 达到窗口阈值）SHALL 保持原语义不变。

三支判定 SHALL 由同一个可导出的纯函数给出，执行路径与测试共用同一实现，SHALL NOT 在两处各写一份条件。

每次因上述任一条件换会话时，该回合的执行行 SHALL 记下成因（`sessionRotatedCause`，取值 `overflow` / `failed_round` / `context_pressure`），使 `sessionRotated: true` 可被读方直接归因，而不必从上一行的 `success` 与 `tokens` 反推。该字段为增量遥测：缺字段表示该行出自本改动之前，读方不得据此判定轮换「没有原因」。

#### Scenario: 上一轮是 missed，不换会话

- **WHEN** 定时任务的 `history[]` 最后一行是 `{kind:"missed", success:null}`（排期到了但从未开始），且没有溢出标记、token 未达阈值
- **THEN** 下一次排期轮 SHALL NOT 换会话：`sessionId` 保持不变，该执行行 SHALL NOT 带 `sessionRotated`
- **AND** 累积的上下文 SHALL 继续被沿用

#### Scenario: 上一轮真失败，照常换会话

- **WHEN** `history[]` 最后一行是 `{kind:"execution", state:"failed", success:false}`
- **THEN** 下一次排期轮 SHALL 换一个新会话
- **AND** 该执行行 SHALL 记 `sessionRotated: true` 且 `sessionRotatedCause: "failed_round"`

#### Scenario: token 达阈值，照常换会话并标明成因

- **WHEN** 最新一个带 `tokens` 的回合 `cacheReadTokens + inputTokens` 达到窗口阈值
- **THEN** 下一次排期轮 SHALL 换会话
- **AND** 执行行 SHALL 记 `sessionRotatedCause: "context_pressure"`

#### Scenario: 旧数据没有 kind 时按形状回退分类

- **WHEN** 历史行缺少 `kind`，形如 `{success:null, missed:3}` 或 `{success:null, note:"…"}`
- **THEN** 它们 SHALL 分别被识别为 `missed` 与 `meta`
- **AND** SHALL NOT 触发轮换（与有 `kind` 的新行同一结果）

#### Scenario: 手工回合不轮换

- **WHEN** 任务的 `trigger` 不是 `schedule`
- **THEN** SHALL NOT 因上述任何条件换会话（原语义不变）

### Requirement: 任务列表的「上次结果」按历史行类型表述

`cron_list` 一类读面在表述任务的「上次结果」时 SHALL 按 `history[]` 末行的**类型**分流，SHALL NOT 用 `success` 的真假二分：

- 末行为 `missed`（到期没跑）SHALL 表述为「到期未执行」并带出累计次数（`missed` 字段），SHALL NOT 表述为失败；
- 末行为 `meta` / `queued-upgrade`（元数据留痕）SHALL 表述为**无执行**（中性），SHALL NOT 表述为失败；
- 末行为 `superseded` SHALL 表述为「被新一轮顶替」；
- 末行为 `execution` 时按 `success` 表述：成功为 ok，失败带出 `error` 文本；
- 无 `history` SHALL 表述为「从未运行」；
- 旧数据无 `kind` 时 SHALL 走与写入方同一套形状回退分类（`classifyHistoryEntry`），SHALL NOT 在调用方另写一套判断。

该表述 SHALL 由读面模块（而非 MCP 传输层）提供纯函数实现，使它可以被单测直接驱动。

#### Scenario: 到期没跑的任务不显示成失败

- **WHEN** 某任务末行是 `{kind:"missed", success:null, missed:8}`
- **THEN** 列表 SHALL 显示「到期未执行 ×8」一类的表述
- **AND** SHALL NOT 显示 `failed:` 前缀

#### Scenario: 元数据留痕不显示成失败

- **WHEN** 某任务末行是 `{kind:"meta", success:null, note:"…"}`
- **THEN** 列表 SHALL 显示中性表述或明确说明尚无执行
- **AND** SHALL NOT 显示 `failed:` 前缀

#### Scenario: 真失败仍带出原因

- **WHEN** 某任务末行是 `{kind:"execution", state:"failed", success:false, error:"502 upstream"}`
- **THEN** 列表 SHALL 显示失败并带出该 `error` 文本

#### Scenario: 存量行没有 kind 时与写入方同口径

- **WHEN** 末行缺少 `kind`，形如 `{success:null, missed:3}`
- **THEN** 分类 SHALL 与 `classifyHistoryEntry` 逐字一致（`missed`）
- **AND** 表述 SHALL 与带 `kind` 的新行相同

### Requirement: 派生报告只在真跑过的回合上产生

由任务历史派生的报告行（a2a 舰队回合的 derived 摘要）SHALL 只对 `history[]` 末行为 `execution`（真跑过的回合）生成，且成功与否 SHALL 按 `success === true` 判定：

- 末行为 `missed`（到期没跑）SHALL NOT 生成派生报告——一轮都没开始，没有「回合完成」可言；
- 末行为 `meta` / `queued-upgrade` / `superseded` SHALL NOT 生成派生报告（它们都不是已收尾的回合）；
- 判定 SHALL 走写入方同一套分类（`classifyHistoryEntry`），SHALL NOT 用 `success !== false` 之类把「没有 success」读成成功。

理由：`success !== false` 会把 `{success:null, missed:N}` 读成**成功**，于是车队报告车道里出现一条「回合完成（无文本产出）」、blockers 为空的**假成功**——比标签错更重，因为它进入报告面并被下游当作结论。

#### Scenario: 到期没跑不产出「回合完成」

- **WHEN** 某 a2a 舰队任务末行为 `{kind:"missed", time:"…", success:null, missed:3}`
- **THEN** 派生报告 SHALL 不生成（返回空）
- **AND** SHALL NOT 出现 summary「回合完成」或空的 blockers

#### Scenario: 校准留痕与被顶替同样不产出报告

- **WHEN** 末行为 `{kind:"meta", success:null, note:"…"}` 或 `{kind:"superseded", success:false, supersededBy:"…"}`
- **THEN** 派生报告 SHALL 不生成

#### Scenario: 真失败的回合仍产出带 blockers 的报告

- **WHEN** 末行为 `{kind:"execution", state:"failed", success:false, error:"502"}`
- **THEN** 派生报告 SHALL 生成，summary 指明执行失败且 blockers 含该 error 文本

### Requirement: 早停结论落到任务执行记录，两种结算形状同等对待

一轮回合在跑完之前被停下时，任务执行记录 SHALL 携带执行器自己给出的结论；执行器以哪种形状结算 SHALL NOT 影响该结论是否落盘。

- 结论 SHALL 从**两种结算形状**读取，二者同等有效：① 结算为**抛错**、结论已摊平到顶层（`budgetSoftStop` / `contextOverflow` / `contextPressure`）；② 结算为**正常返回**的失败对象、结论嵌在 `detail` 里（`detail.budgetSoftStop` / `detail.overflow` / `detail.contextPressure`）。只读其中一层 SHALL 视为不满足本要求（2026-11-15 实证：工人池车道走 ②，而读侧只读 ①，于是该车道自陈承载大部分流量、其结论却一条都没落过盘）。
- 扁平名与嵌套名的对应关系 SHALL 逐条写明：扁平 `contextOverflow` ↔ 嵌套 `detail.overflow`；`budgetSoftStop` 与 `contextPressure` 两层同名。把两者当成一对一改名 SHALL 视为不满足本要求。
- 「下一轮换会话」的决定 SHALL 同样由上述两种形状的溢出结论驱动；该决定依赖错误文案的措辞 SHALL 视为不满足本要求（文案匹配只保留为无结构化结论时的回退）。
- 任务执行记录行 SHALL 携带收尾车道的结论：补数已执行时记 `wrapUp`（含 `ok` 与 `chars`，失败时附 `error`）；补数被跳过时记 `salvageSkipped`（`isFleet` / `interrupted` / `pressure` / `softStop` / `reported`）。两者都缺时，读面无法区分「停下但交出了一份报告」与「停下且什么都没交」——这两种形态的操作员动作不同。
- 记录结论 SHALL NOT 改变回合的成功/失败判定：被停下的回合仍不是成功，因为它没有跑完。

#### Scenario: 工人车道的软停回合在任务记录上带标记

- **WHEN** 一轮回合在工人池车道上被预算软停、执行器以**正常返回**的失败对象结算（结论在 `detail` 里）
- **THEN** 任务执行记录的该行带失败状态、命名该次停止的消息，以及软停标记
- **AND** 该标记在落盘后的存储记录里仍然存在

#### Scenario: 抛错结算的软停仍带标记

- **WHEN** 一轮回合被预算软停、执行器以**抛错**结算（结论已摊平到顶层）
- **THEN** 任务执行记录的该行同样带软停标记，与工人车道的形状无差别

#### Scenario: 工人车道的溢出结论驱动下一轮换会话

- **WHEN** 工人车道的回合以 `detail.overflow` 宣告上下文溢出、而错误文案里没有任何溢出措辞
- **THEN** 下一轮 SHALL 在新会话上开始

#### Scenario: 只有上下文压力不换会话

- **WHEN** 工人车道的回合以 `detail.contextPressure` 宣告压力、但没有 `detail.overflow`
- **THEN** 下一轮保留原会话，同时该行的压力结论仍然落盘

#### Scenario: 收尾结论出现在任务记录行上

- **WHEN** 一轮被停下的回合触发了收尾补数并拿到内容
- **THEN** 该行带 `wrapUp`，其中 `ok` 为真且 `chars` 为补到的字符数
- **AND** 补数被跳过时该行带 `salvageSkipped` 及跳过原因，而不是留空

#### Scenario: 自行失败的回合不带标记

- **WHEN** 一轮回合以上游连接中断之类的普通错误失败
- **THEN** 该行不带软停标记、不带压力标记、也不带收尾结论
- **AND** 「没问过收尾」这件事本身仍以 `salvageSkipped` 记录，不与「问过但失败」同形

#### Scenario: 成功回合不带标记

- **WHEN** 一轮回合正常跑完
- **THEN** 该行不带软停标记，其成功判定不变
