# Design: concurrent-chat-sessions

## Context

动机见 proposal.md「Why」。这里只放决定方案形状的现状与约束。

**运行时拓扑**：一个 cell = 一个 `server.js` + 一个 dsh 子进程，所有会话（web、cron、bot、delegation）复用这一个子进程，按 `sessionId` 多路复用。dsh 0.2.0-rc.2 的硬约束：**一个会话的回合在另一会话仍有挂起 LLM 请求时无法收尾**（合同 ⑨ 实测，`scripts/lib/dsh-contracts/contracts.mjs:719-747`）。因此「共享子进程内同一时刻最多一个开着的回合」是本设计必须守住的不变量——不是偏好，是正确性。

**取消点**：`server/agent-session.js:102-129` `stopStreamingForSessionNavigation()`，被 `switchToSession()`（:162）与 `createNewSession()`（:135）调用；`ws.js:538-558` `stop_turn` 另有一份几乎相同的显式停止实现。

**已建成的按会话基础设施**（live-runtime-control D4 / add-session-ownership / add-reconnect-resync）：`ctx.turnStateBySession` + `isStreamingFor` / `setStreaming` / `streamingSessions()`（`context.js:46-96`）；`sendToViewers(sid)` 按 viewer 投递（`context.js:301-343`）；事件泵按通知自带 sid 路由到 `webTurnSessions`（`dsh-events.js:231-235`）；每会话重放缓冲 `turnBuffers`；`switch_session` 应答携带 `running` + `turnEvents`（`ws.js:889-909`）；客户端 `chat-store.ts:983-1140` 据此重建活流。

**四个各自等 idle 的行动者**，彼此不可见：

| 车道 | 怎么判「忙」 | 怎么标「我在跑」 | 等不等 |
|---|---|---|---|
| web prompt | 仅同会话 `isStreamingFor(sid)` | `turnStateBySession` | 不等（跨会话直接派发）|
| cron 任务 | `waitForIdle` 轮询 `ctx.isStreaming` | **仅** `sessionCollectors`（不写 turnState）| 等 |
| delegation 汇总注入 | 同 cron | `turnStateFor(initiator)` | 等 |
| bot 消息 | 不判 | `sessionCollectors` | 不等 |

后果：`ctx.isStreaming` 在 cron / bot 回合期间为 **false**；今天 web prompt 撞上 cron 回合、两个 Tab 分别提问、bot 消息撞上 web 回合，三种情况都会把两个回合并发派进子进程。这些是本设计顺带要收口（web 侧）或明确留给 v2（bot 侧）的既有缺口。

**全局指针** `ctx.dshSessionId`（经 `chatHistory.currentSessionId()` 读）仍承担：未落行的新会话在列表中的合并、`accessSession` 对未落行活会话的放行、删除守卫、`model/set` 的默认目标会话、无 sid 通知的归属。`llm/retry` 两处（`dsh-events.js:402,416`）错误地用指针而非事件 sid 投递。

**客户端**：`chat-store.ts` 的 `isStreaming` 是当前视图的单布尔；`606-607` 丢弃 sid 不等于当前视图的事件；`Sidebar.tsx` 只有 `isCurrent`，没有逐会话回合状态。

## Goals / Non-Goals

**Goals:**

- 切会话 / 新建 / 深链 / 多 Tab 导航对任何进行中回合零影响；切回即见活流（复用既有重建链路，不新造）。
- web 车道的「一次一个回合」由**一个**仲裁点强制，且该仲裁点能看见 cron / bot 的回合（消除 web 侧三种并发缺口）。
- 排队态对用户可见、可取消、可从排队直接「夺权」（停上一个立即跑）。
- 派发策略是一处可翻转的缝；真并发的开启条件被合同钉住，而不是靠口头约定。
- 回滚不需要重新出片。

**Non-Goals:**

- 按会话独立 dsh 子进程 / 多子进程路由（D4 Non-Goal 维持；worker-pool 的多子进程只服务任务车道）。
- 改 dsh 子进程或 `platform-preset-bridge` 插件模板。
- 把 cron / bot 回合纳入派发器成为正式车道（v2「lanes」；本次只让派发器**看见**它们并给 cron 一个预约标记）。
- 提高并发度（`concurrent` 策略只预留缝，本 change 不开启）。
- 重定义全局指针的其余职责。

## Decisions

### D1: 新增宿主级派发器 `server/turn-dispatch.js`，web prompt 全部经它派发

`attachTurnDispatch(ctx)`（沿 `attachTurnStateModule` / `attachWorkerPool` 的 attach 模式）提供：

- `ctx.dispatchTurn({ sessionId, text, run, ws })` → 同步判定：运行时空闲则**立即**执行 `run(sessionId)`（现有 prompt 分支的全部逻辑搬进 `run` 闭包：user 回显、mirror、expandDocRefs、`ctx.session.prompt(text, sid)` 或 remote fork）；忙则入队并向该会话 viewers 发 `queued`。返回 `{ dispatched: true } | { queued: true, position } | { rejected: reason }`。
- 队列：`Map<sid, entry>` + FIFO 顺序数组；**每会话至多一条**；总上界 `TURN_QUEUE_MAX`（默认 8）。
- `ctx.drainTurnQueue()`：运行时空闲且队非空 → 弹出队首，**同步**置 `turnStateFor(sid).isStreaming = true`（与 chat-streaming 的「派发前同步置守卫」要求同构），再执行 `run`。
- drain 触发点：① `finishTurn` 尾部（web 回合结束）；② collector 注销（cron / bot / delegation 回合结束，见 D2）；③ `bridge.ready`（重启后）；④ **安全轮询**：队非空时每 `TURN_QUEUE_POLL_MS`（默认 2000）检查一次，队空即停。轮询是兜底而非主路径——未来新增车道忘记发信号也不会把排队项困死。
- `ctx.cancelQueued(sid)` → 出队，向 viewers 发 `dequeued{reason:"cancelled"}`。
- `ctx.isQueuedFor(sid)` / `ctx.queuedSessions()` 供守卫、侧栏、删除保护读取。

**备选否决**：在 `dsh-bridge.prompt()` 内串行化——桥是运行时无关的传输层，看不到 viewer、排队播报、取消，也覆盖不到不经桥的 remote-agent fork；客户端排队（收到 `done` 再发）——多 Tab / 多端无法协调，只有服务端看得见全部回合。

### D2: 「忙」= 共享子进程有任何开着的回合，不只是 web 的

`ctx.runtimeBusy()` = `ctx.isStreaming || ctx.sessionCollectors.size > 0 || ctx.runtimeReservations.size > 0`。

- `sessionCollectors` 是 cron / bot / delegation 在共享子进程里跑回合的唯一痕迹（`collectTurn` 在 prompt **之前**注册，所以可见性及时）。worker-pool 用 worker 本地 collector map，不计——它们是独立子进程，本就不受 rc.2 约束。
- `runtimeReservations: Set<token>` 是新增的极小原语：任何车道在「已决定要 prompt 但回合状态尚不可观测」的窗口里放一个 token。本次只有 cron 用它：`switchPresetForJob` 的 `waitForIdle` 通过后立即预约，`collectTurn` 注册 collector 时释放（失败路径同样释放）。原因：cron 的 preset 切换会触发 `bridge.ready`，而 D1 的触发点 ③ 恰好在那一刻 drain——没有预约，每个「换 preset 的 cron 任务 + 一条排队中的 web prompt」都会把两个回合同时派进子进程。这把今天一个很窄的竞态变成系统性竞态，必须关。
- collector 注销要能触发 drain：`collectTurn` 的 finally 里调 `ctx.onRuntimeIdle?.()`（派发器挂上）。改动两行，位于 `server/cron-runner.js`。
- cron 侧的 `waitForIdle` 保持只看 `ctx.isStreaming`：web drain 在 idle 转换瞬间事件驱动地同步预占，cron 的轮询下一拍就看到忙——web 先于 cron 是可接受的优先级（用户交互 > 后台任务），且 cron 本就有等待超时与重试。

**备选否决**：让 cron / bot 回合也写 `turnStateBySession`——会把它们的事件误导进 web 机制（`finishTurn` 会向 viewers 发 `done`、重置重放缓冲），破坏 collector 隔离；统一仲裁器把所有车道变成 lanes——正确的终局但回归面覆盖 cron 引擎、bot runner、delegation，超出本次。

### D3: 切换与新建不再停流；`stopStreamingForSessionNavigation` 退役；`stop_turn` 成为唯一取消路径

- `switchToSession()` / `createNewSession()` 删去对 `stopStreamingForSessionNavigation()` 的调用。该函数删除。
- `stop_turn` 吸收它的 remote-abort 分支（`agent-session.js:106-113`）：若 `ctx.activeRemoteTurnAbort?.sessionId === stopSid` → `finishTurn("aborted")` + `abort()`。今天 `stop_turn` 对 remote 回合只发 `cancelSession`（dsh 侧 no-op），不会收尾——这是顺带修掉的既有缺陷。
- `stop_turn` 新增排队态分支：`isQueuedFor(stopSid)` → `cancelQueued(stopSid)`，不触碰 dsh。
- 新增 `preempt` 语义（排队气泡上的「停止它并立即执行」）：客户端发 `stop_turn{ id: waitingOnId }`——即对**被等待的那个会话**发停止，与「切到 A 再按停止」完全等价，不引入新消息类型；A 收尾触发 drain，B 自然派发。
- `promptStopped` 标记保留，仅由 `stop_turn` 置位（prompt promise 因 cancel 被拒时据此静默）。
- `remoteAbort.switchedAway` 字段删除（不再有导航中止）。

**备选否决**：保留导航停流但只对「无其他 viewer」的会话停——语义诡异（开第二个 Tab 看着就不停了），且仍丢用户工作。

### D4: 协议增量——`queued` / `dequeued` 事件、`sessions.turnStatus`、`session_loaded.queued`

全部 additive，旧客户端忽略即退化为「切走后原回合继续跑、排队项静默等待」。

- 服务端→客户端 `queued { sessionId, text, position, waitingOn: { id, title } | null }`：入队时发给该会话 viewers，位于 `user` 回显**之前**（排队项尚未成为历史，不发 `user` 回显——见下）。`waitingOn` 为 null 表示在等非 web 回合（cron / bot），气泡文案退化为「等待运行时空闲」。
- `dequeued { sessionId, reason: "dispatched" | "cancelled" }`：派发时先发 `dequeued{dispatched}` 再走正常 `user` 回显 → `agent_start`；取消时发 `dequeued{cancelled}`。客户端据此确定性地清掉排队气泡，不依赖推断。
- `sessions[]` 条目增 `turnStatus: "running" | "queued" | null`；`broadcastSessions` 在入队 / 出队 / 派发时也触发（今天只在 `finishTurn` 触发）。侧栏据此渲染指示。
- `session_loaded` 增 `queued: { text, position, waitingOn } | null`，与 `running` 同构：切到或刷新一个排队中的会话能还原气泡。

**mirror 与配额的时点**：用户消息在**派发时**才 `recordMessage` 进 SQLite（历史 = agent 实际收到的；取消的排队项不留孤儿 user 行）；排队文本由服务端队列项持有，`session_loaded.queued.text` 供刷新还原。demo 配额在**入队时**扣（提交即消费；取消不退——配额是 20 条量级，简化优先，spec 如实写明）。

**备选否决**：复用 `user` 回显加 `queued:true` 标志——位置会变、取消需要独立信号、且会导致历史里出现从未派发的消息。

### D5: 同步预占 + 同会话守卫覆盖排队态 + 上界

- 入队与派发都在**首个 `await` 之前**完成状态写入（入队：队列项 + `isQueuedFor` 可见；派发：`isStreaming = true`），与 chat-streaming「守卫同步置位」要求一致。
- 同会话第二条 prompt：`isStreamingFor(sid) || isQueuedFor(sid)` → 拒绝（沿用「The agent is still responding」错误形状；排队态文案区分「该会话已有一条消息在排队」）。
- 队满：拒绝并发 `error{ code: "queue_full" }`，客户端 toast。
- 队列只存内存：进程退出即丢（与重放缓冲同一诚实等级）；但**子进程重启不丢**——`bridge.exit` 不清队，`bridge.ready` 后 drain。MCP 热更 / preset 切换这类计划内重启不应吞掉用户已提交的消息。

### D6: 全局指针语义收敛为「最近被定向的会话」；派发显式带 sid；修 `llm/retry` 归属

- `beginTurnFor` 的指针移动（`setSessionId(target)`）保留在入队时（它同时负责欢迎态铸造新会话，必须在入队时发生才能让 `queued` 有目标、侧栏出现新会话）。指针因此只表示「最近被定向的会话」。它剩余的职责（见 Context）全部容忍这一语义。
- `ctx.session.prompt(text, sid)`：shim 用 `sid ?? chatHistory.currentSessionId()`；两个 ws 调用点与派发器闭包显式传 `target`。消除 `expandDocRefs` 的 `await` 之后读指针导致的错归属（并发下必然触发）。
- `dsh-events.js:402,416` `llm/retry` 改用事件自身 `sid`（它们是 `session.event`，一直有 sid）。否则 A 在后台重试时 B 的 viewers 会看到 A 的重试条。

**备选否决**：把指针移到派发时刻——需要拆 `beginTurnFor`，且欢迎态铸造会话仍得提前，收益不够。

### D7: 删除守卫扩展为「进行中或排队」

`chatHistory.deleteSession(id)` 的 `active` 判定 = `id === currentSessionId() || activity(id).streaming || activity(id).queued`。`chat-history.js` 不持有 ctx，新增 `setActivityProbe(fn)` setter（与 `setSessionManager` / `setDshBridge` 同款），`server.js` 注入 `(id) => ({ streaming: ctx.isStreamingFor(id), queued: ctx.isQueuedFor(id) })`。REST `DELETE` 与 WS 共用同一函数，自动覆盖。409 文案保持 `Cannot delete the active session; switch first` 不变（客户端已依赖）。

指针守卫**保留**（conservative）：指针会话即使空闲也不可删——改它要动 `accessSession` 的未落行放行逻辑，与本次无关。

客户端 `Sidebar.tsx` 删除菜单禁用条件：`isCurrent || turnStatus !== null`。

### D8: 策略缝 `TURN_DISPATCH = legacy | queue | concurrent`，默认 `queue`

- `legacy`：保留今天的行为（切换即 cancel、跨会话直接派发）。**唯一用途是回滚**：spawner 给 cell 加 env 重启即可，不需重新出片。下一个归档周期删除。
- `queue`：本设计。
- `concurrent`：忙也直接派发（把今天双 Tab 的意外行为变成有意行为）。**禁止**在未通过严格 ⑨（D9）的 dsh 矩阵上开启——spec 写成 SHALL NOT，启动时若 `concurrent` 且矩阵未标记通过则降级为 `queue` 并告警。翻转默认值属于未来的 dsh 升级 change，不在本次。
- 选 env 而非 DB 偏好：这是「部署与 dsh 矩阵的能力声明」，不是用户选择；且回滚场景要求无需进 UI。

即便将来开 `concurrent`，派发器仍保留为背压点（`TURN_CONCURRENCY_MAX`，本次不实现）——词元车道有 per-key 并发上限（合同代码里记录过 subagent 的 gateway concurrency rejection），单子进程负载也有限。

### D9: 合同 ⑨ 增严格「收尾交错」advisory 变体，作为 spike 判据与策略翻转条件

- `contracts.mjs` 新增 `{ id: "multi-session-close-interleave", title: "⑨b close-under-concurrency", advisory: true }`：复用 ⑨ 的 A 挂起 / B 派发布置，然后释放 dummy LLM，**断言 A、B 在界内（20s）都收敛到 `idle`**，期间不发 cancel。
- runner `dsh-contracts.mjs` 的行循环识别 `advisory`：照常打印 PASS/FAIL 与 detail，**不计入 `failures`**，总判定与 exit code 不受影响。摘要末尾单独一行列出 advisory 结果。
- spike 配方（写进 tasks）：`npm run dsh:contracts -- --tree <scratch 0.2.1-rc.2>`，读 ⑨b 行。绿 → 开一个 dsh 升级 change（矩阵升级 + `TURN_DISPATCH` 默认翻 `concurrent` + ⑨b 升格为门禁）；红 → 本设计即终态，记录到 dsh-version-matrix 台账。
- 不把 ⑨b 直接做成门禁：它在当前矩阵（rc.2）必红，会让 `dsh:contracts` 永远 exit 1。

### D10: 客户端——排队态进 store，气泡与侧栏指示从服务端状态渲染

- `chat-store.ts` 增 `queuedTurn: { text, position, waitingOn } | null`（当前视图）：由 `queued`（sid 等于当前视图）与 `session_loaded.queued` 置位；由 `dequeued` / `agent_start` / `session_loaded`（无 queued）清除。沿用 `606-607` 的 sid 过滤。
- 排队气泡：渲染在转录末尾、用户消息位置，带「排队中 · 等待《{title}》完成」与两个动作：「取消」→ `stop_turn{id: current}`，客户端收到 `dequeued{cancelled}` 后把 `text` 回填进输入框（用户一键可重发；排队项从未是历史，不留气泡）；「停止它并立即执行」→ `stop_turn{id: waitingOn.id}`（D3）。`waitingOn` 为 null 时只显示「等待运行时空闲」与「取消」。
- 排队态下 `canSend = false`（同会话一条），停止控件可见（语义为取消排队）。
- `Sidebar.tsx`：会话行按 `turnStatus` 渲染 running（现有 loader 样式）/ queued（时钟图标）；无需新订阅——`sessions` 消息已是侧栏真源。
- `types/ws.ts` 增 `queued` / `dequeued` 服务端消息与 `turnStatus`、`session_loaded.queued` 字段。
- 不改 `switch_session` 的发送时机与乐观切换骨架（perf-session-open）。

## Risks / Trade-offs

- [A 是五分钟的 agentic 回合，B 要等五分钟] → 侧栏能看见 A 在跑、B 在排；气泡提供「停止它并立即执行」；`concurrent` 缝为将来留着。这是 rc.2 约束下的诚实上限，spec 如实写。
- [bot 车道仍不仲裁：bot 消息撞上 web 回合会并发] → 既有缺口，不被本次放大（派发器能看见 bot 的 collector，web 侧不会反向撞它）；记入 v2 lanes。
- [后台回合跑很久，重放缓冲（2000 事件 / 1MB）溢出] → 既有 miss 契约：`running:true` 无 log，客户端显示进行中、在 `done` 收敛；见 Open Questions 是否放宽上界。
- [`finishTurn` → drain → 同步预占 与 cron `waitForIdle` 轮询的先后] → web 事件驱动必先于 cron 轮询拍；cron 预约 token（D2）关掉 bridge.ready 窗口；cron 等待超时与重试契约不变。
- [删掉 `stopStreamingForSessionNavigation` 后 `resync:true` 路径语义] → 该路径本就「never navigate」，不受影响；但它是 D4 点名的回归面，e2e 全量跑。
- [demo 配额入队即扣、取消不退] → 文案明示；sandbox 20 条量级。
- [`legacy` 模式多一条代码路径] → 一个 `if`；归档时删除，tasks 标注。
- [e2e `composer-stop.spec` 为 main 固有 flaky（基线 7 轮 5 红）] → 先量基线再比较，不把既有 flaky 记到本次头上。
- [旧客户端（小程序 / 旧 web 缓存）遇到新服务端] → 全部字段 additive；行为退化为「切走原回合继续、排队静默等待、派发后正常收流」，无崩溃面。

## Migration Plan

1. 单 PR、纯 cell 侧：派发器 + ws / agent-session / dsh-events / chat-history 改动 + 客户端 + ⑨b advisory。随常规出片滚动，无 env / 网关 / 矩阵变更。
2. 上产验收走真实账号端到端（module-vs-e2e 教训）：两个会话交替提问、切走切回、刷新还原排队气泡、「停止它并立即执行」、多 Tab 导航互不影响、cron 任务期间提问进排队且 cron 结束后自动派发。
3. 回滚：spawner 给 cell 加 `TURN_DISPATCH=legacy` 重启，无需出片；若需彻底回滚则 revert PR。
4. 并行 spike：`npm run dsh:contracts -- --tree <0.2.1-rc.2 scratch>` 读 ⑨b；结论记入 dsh-version-matrix 台账，决定是否立 dsh 升级 change。

## Open Questions

- 重放缓冲上界（2000 事件 / 1MB）是否因「后台回合长期无人观看」而放宽（例如 5000 / 4MB）？不改任何契约，只改常量；观察真实后台回合的 miss 率后定。
- `legacy` 模式在哪个归档周期删除？建议下一个 change 归档时一并清。
