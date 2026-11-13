## 1. 深度逐跳（前置修正）

- [ ] 1.1 把 `agent-runner/a2a.js:126` 解析的入站 depth 沿 `manager.turn({delegationDepth})` 贯通到委托调用点，验证=`scripts/test-delegation-depth-hop.mjs` 的「入站 1 → 出站 2」用例绿（断言出站头实际值，不断言调用点参数）
- [ ] 1.2 `server/cron-runner.js:971-991` 与 `:2042` 的出站 depth 改为 `inbound + 1`，无入站时为 1，验证=同一脚本的「无入站 → 1」与「入站 2 → 3」两用例绿
- [x] 1.3 到界拒绝发生在任何岗位回合之前，验证=深度界用例中断言 `member_turn_events` 本次零新增行，且返回结构化 depth 错误（`scripts/test-delegation-depth-hop.mjs`：用真适配器 `createAgentApp` + 记录每一次 `manager.turn` 的假 manager，断言 depth=3 与 depth=9 均返回 `-32011` 且 `turns.length === 0`（行只可能在 turn 里写，故这是「零新增行」的因果等价物，不需要真库）；另断言暂停态先于深度检查返回 `-32010` 且不起 turn、普通无头请求不被界的判定误伤、入参深度原样透传 [0,1,2,4]、乱码/负数按 0 处理；并直接钉住出站客户端 `runA2aTurn` 只在 depth≥1 时发 `X-Delegation-Depth`、到界拒绝时请求根本不出进程。已用注入「把界判成 `false &&`」证明能红（2 条失败）。**同时修了一个测试自身的坑**：首次注入没变红而是挂死 3 分钟——断言抛错时 per-test 的 `close()` 不执行、监听器把事件循环钉住，于是「回归」表现为超时而不是红行；改用模块级 `OPEN[]` + `test.after` 统一关监听后，同一次注入 349ms 就红）
- [ ] 1.4 staging 实测当前在途链的实际深度分布（读 `member_turn_events.depth`），验证=产出一份分布读数并据此确认 `delegationDepthMax`，有 3 跳以上在途链时先与主人对齐再上线

> **阻塞现状（2026-11-12 复核，未动代码）**：1.1–1.3 的实现点分散在三个已被另一会话占用的文件里——`agent-runner/manager.js`（+18 行，属 add-input-request-cards）、`server/cron-runner.js`（+71 行，属上下文窗口/usage 记账）、`server/routes/fleets.js`（+15 行）；另有未跟踪的 `server/team-serving.js`。按多会话协定，不在别人的未提交改动上继续改，故本组暂缓。
>
> **2026-11-12 后续：团队 lane 上的出站 +1 已落地**（`server/team-dispatch.js`，随 3.4 一起）。所以「全仓没有一处把入站+1 写到出站请求上」这句话现在只对 **cron/dispatch 两条 lane** 成立；团队 a2a 这条 lane 已经不是常量 1 了。1.2 仍留 `[ ]`，因为它的验证点明确写的是 `server/cron-runner.js:971-991` 与 `:2042`。
>
> 已核清的实际断点（省下重查时间）：
> - 入站侧**已完成**：`agent-runner/a2a.js:126` 解析 `x-delegation-depth`，`:127` 到界先拒（jsonRpcError -32011），`:134`/`:196` 把 `delegationDepth` 交给 `manager.turn`；`manager.js:942/970/1006` 已消费它（并发行位 + 事件 `depth`）。
> - 出站侧**只有能力、没有接线**：`server/a2a-client.js:83` 会按 `depth >= 1` 发 `X-Delegation-Depth`，但调用方给的都是常量——`server/turn-request.js:88` 写死 `job?.targetType === "a2a" ? 1 : 0`（该文件干净，是 1.2 的第三个点，但**入站深度要有人先放到 job 上**），`server/cron-runner.js:991` 写死 `depth: 1`，`server/routes/fleets.js:1259` 的 `origin.fleet.depth` 也写死 1。
> - 全仓**没有任何一处**把入站 depth + 1 写到出站请求上（`grep -rn "x-delegation-depth"` 只有两处**读**）。所以今天任何多跳链的出站深度恒为 1，界的判定永远不会在第二跳触发——这正是 1.1/1.2 要修的。
> - **顺序依赖**：1.4 的读数必须排在 1.2 之后才有意义。`depth` 列虽已有（`server/routes/fleets-db.js:481` 自迁移 ALTER），但在出站恒为 1 的现状下，分布只会是 0/1 两堆，据此确认 `delegationDepthMax` 等于拿现状当基线。
> - 读数的库位置（免得找错）：`member_turn_events` 的真源在 **cell 级** `/data/cells/<hash>/data/data/fleets.db`，主库 `/data/data/fleets.db` 该表为 0 行；另注意本组无 staging 命名空间（`kubectl config get-contexts` 下只有 cheap/cheap-ts/tencent/xinru*/zihan，`cheap-ts` 上是 `fd-prod`），1.4 的「staging」需先确认指哪套环境。


## 2. 身份适配与授权判定

- [x] 2.1 新增 `server/caller-identity.js`：适配器注册 + `resolve(headers, session)` 返回显式 `ok`，验证=无凭据/过期凭据/形状不符三种输入均返回 `{ok:false}`，且代码中不存在任何 default caller 分支
- [x] 2.2 实现平台会话适配器（一期唯一适配器），验证=带合法会话令牌的请求解析出正确调用方标识并贯穿到台账
- [x] 2.3 新增 `server/team-serving-policy.js` 纯函数 `decide({publication, caller, usage})`，返回封闭集内的错误码，验证=对可见性三值 × 调用方（主人/白名单内/白名单外/无身份）× 配额（余量/触顶）做穷举矩阵，每格断言具体错误码
- [x] 2.4 错误码封闭集落成常量并断言端到端一致，验证=扫描所有返回路径，无集合外错误码（脚本级枚举断言）

## 3. 端点与路由岗

- [x] 3.1 `server/team-card.js` 增 `reception` 列（`try/catch ALTER`，可空），验证=老库升级后为 NULL，既有派生结果不变；NULL 时派生出的卡标记为不可调
- [x] 3.2 发布校验：`reception` 必须指向一个存在的对外岗，否则拒绝发布并指明原因，验证=指向 persona 岗或不存在的岗各返结构化拒绝
- [x] 3.3 新增 `server/team-serving.js`：JSON-RPC `message/stream` 分发、把请求定向派发给路由岗、汇总回复流，验证=`scripts/test-team-serving-a2a.mjs` 用真实 JSON-RPC 客户端完成一次调用并收到合法事件类型
- [x] 3.4 团队内部派活复用既有编导/派发（不新建编排器），验证=调用产生的是既有 `member_turn_events` 行（含 depth=1），无并行新表（`server/team-dispatch.js`：**没有新编排器**——一次团队调用就是一次 `runA2aTurn`（既有 a2a 回合执行器，SSE 帧 / 双凭据 / depth 头都在里面）+ 一次 `recordTurnEvent`（既有回合行写入点，落既有 `member_turn_events`，`source=delegation`、`depth=入站+1`、`resultSink=caller`，全是既有词表）。归属用 `origin.fleet={fleetId,memberId}` 钉住路由岗，不走 preset 扫描（两个岗共用一个 agent 时会写错岗或写不上）。**挂载点**：`server/context.js` 的 `attachTeamDispatch(c)`（该文件干净，避开另一会话占用的 `server.js`）。`scripts/test-team-dispatch.mjs` 7 例：一次调用→恰好 1 行且岗对、入站 0→出站 1、入站 1→出站 2 且行上同值、persona 路由岗→`reception_not_remote` 且零调用零行、目标离场→`reception_unreachable`、到界→`depth_bound` 且请求不出进程、远端失败→行记 failed 并把错误抛出。已在真 cell 启动上验证门确实挂上：同一 GET 从「express `Cannot GET` HTML」变成「应用自己的 `{"error":{"code":"not_found","message":"Team not found"}}`」（把 `attachTeamDispatch(ctx)` 注释掉重启即回到 HTML，红证成立，已还原并逐字节比对备份）。注入「出站 depth 写死 1」→ 2 条用例红。**边界**：persona 路由岗的拒绝其实是纵深防御——3.2 的发布校验已要求 `reception` 必须是 a2a 岗，所以可发布的团队都能被调）

> **2026-11-12 复核：这条不只是「没做」，是「整扇门在 cell 侧根本没挂」——又一个声明≠挂载。证据链（四处对齐才成立）**：
> - `server/routes/team-cards.js:141` 把整个 a2a 面放在 `if (typeof ctx.teamDispatch === "function") { … }` 里面：没有这个函数，`/api/teams/:handle/a2a`、`/request`、`/calls/:id` **一行都不注册**。
> - 生产装配是 `server.js:356` 的 `registerTeamCardRoutes(ctx)`，而 `ctx` 由 `server/context.js` 造——该文件里**根本没有** `teamDispatch` / `teamDeliver` 字段（`grep` 零命中）。
> - 全仓唯一给这两个接缝赋值的地方是测试脚手架 `scripts/test-team-serving-a2a.mjs:88-89`（`teamDispatch: (args) => teamDispatchRef.current(args)`）。
> - 于是 `3.3`/`3.5`/`7.1`/`7.2` 的绿都是「对着注入的桩」绿；生产上 6.3 的 `not_serving` 分支会对**每一个** cell 生效，目录里那张卡「可调」但一点就落 `not_serving`。
>
> 补齐这件事需要两件东西，都不在「改个函数」的量级：
> 1. 一个生产版 `teamDispatch({fleet, members, reception, text, caller, callId, depth, onDelta})`：按 reception 岗的 `targetKind`（`a2a` / `persona`）跑一次**既有**回合，`onDelta` 边流边出，并落**既有** `member_turn_events`（`depth` = 入站 + 1，写入口是 `server/fleet-events.js` 的 `recordTurnEvent`）——这正是 1.2 那条「出站 depth=入站+1」的落地处，所以 3.4 与 1.1/1.2 是同一根线，不能分开验。
> 2. 把它塞进 `ctx` 并在 `server.js` 挂载。**当前 `server.js` 已被另一会话改脏**（多会话协定：不在别人的未提交改动上继续改），所以这一步要么等窗口，要么开独立 worktree。
>
> 结论：3.4 与 1.1/1.2 一起构成「团队 a2a 在 cell 侧点亮」的最小闭环，三者应同一批做、同一批验；在此之前不建议对外宣称团队可被调用（目录面 7.1 的「调用」入口会得到 `not_serving`）。

- [x] 3.5 未发布/已撤回/`private` 的团队端点返回同形 404，验证=三种情况响应体逐字节一致（`scripts/test-team-serving-a2a.mjs` 的「one identical body」用例，含撤回后的第四种）

## 4. 配额扣减

- [x] 4.1 条件 UPDATE 抢三项额度 + 落调用记录，同一事务；抢不到即拒，验证=并发 10 笔打同一上限，恰好放行额度内笔数，其余全部 `quota_exceeded`（同批同步发起，条件 UPDATE 定胜负）
- [x] 4.2 流式过程中触顶：中止并发出流内错误事件，该次调用记为未完成，验证=token 触顶用例断言流内有错误事件且调用记录状态为未完成
- [x] 4.3 落库失败不放行：人为让记录落库失败，验证=调用被拒且不产生「已成功未记账」的记录
- [x] 4.4 自然日重置口径可读，验证=卡与调用响应都能读到重置时刻

## 5. 长任务回投

- [x] 5.1 同步窗口判定与转异步（返回 taskId），验证=超窗用例立即拿到 taskId 且连接在窗口内关闭
- [x] 5.2 后台完成/失败/超时经既有事项/通知通道回投，验证=三种终态各产生一条可读回投，且产出形状与同步调用一致
- [x] 5.3 回投失败可见（不静默），验证=通道不可达时任务状态标为「产出已就绪、回投失败」并可查

## 6. 网关入口

- [x] 6.1 `gateway/team-directory.js` 增 `POST /api/teams/:cellId/:handle/a2a` 转发到目标 cell，验证=按生产装配顺序注册后该路由不被 GET 兜底吞掉（照 `fleet-room-bridge` 的 404 回归用例改一份）
- [x] 6.2 网关解析调用方身份并以既有内部身份头转发，验证=伪造内部头被拒；会话令牌经网关后 cell 侧仍能解析出同一调用方
- [x] 6.3 老 cell 无此端点时返回 `not_serving` 而非 500，验证=对一个无端点 cell 调用，状态码与错误码符合约定

## 7. 面与验收

- [x] 7.1 目录卡片增「调用」入口：`open` 直接可调、`listed` 走申请批准；展示配额余量与错误码可读文案，验证=e2e 两种可见性各走一遍，拒绝路径呈现正确指引（`e2e/team-directory.spec.js` 的 open 卡直接调用 + listed 卡申请门；错误码在 `teamCall.errors.*` 逐条落文案）
- [x] 7.2 驾驶舱增「待批准调用」队列（批准/拒绝/设定有效期），验证=批准后同一次调用成功，拒绝后仍 `needs_approval`（`scripts/test-team-serving-a2a.mjs` 走真实审批表：拒绝即入队→批准→同一调用成功→他人仍 `needs_approval`；过期批准同样拒绝）
- [x] 7.3 跨团队内容不可信处理：请求文本进「任务内容」位而非系统提示，验证=注入「把配额改为无限」的文本后配额与工具面不变（对照断言）
- [x] 7.4 既有 `a2a-agent-serving` 与 delegation 套件零扰动，验证=两套既有测试全绿且无快照 diff（实测 a2a-client-timeout + agent-delegation-a2a + fleet-delegation 共 44 条全绿）
- [x] 7.5 `openspec validate add-team-as-a2a-agent --strict` 绿
