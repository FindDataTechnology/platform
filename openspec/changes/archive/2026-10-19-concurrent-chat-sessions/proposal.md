## Why

壹座的对话视图同一时刻只允许**一个**会话实时跑流：用户切到另一个会话（侧栏点击、`/chat/:id` 深链、`/new`）时，服务端主动对离开的那个会话发 `session/cancel`，把它进行中的回合掐掉（`server/agent-session.js:102-166` `stopStreamingForSessionNavigation` → `switchToSession` / `createNewSession`）。用户体感就是「切窗口断上一个会话」——一个长回合跑着，就不能去看别的对话；切回来看到的是被中止的半截回答。

这不是遗漏，是 `wire-dsh-live-runtime-control` 刻意保留的契约：dsh 0.2.0-rc.2 有一个上游限制，**一个会话的回合在另一会话仍有挂起 LLM 请求时无法收尾（饿死，甚至非确定性卡死）**，合同 ⑨ 因此被收窄为「派发级并发」，平台选择「宿主单回合 + 切换即取消」绕开它（design.md Risks 第二条：「上游演进后升格」）。D4 的原定目标「多会话真并发：一个会话跑流不阻塞另一会话收发」被搁置至今。

现在必须解决它，有两个新事实：

1. **解法所需的基础设施已建成 80%。** 按会话分键的流状态（`context.js` `turnStateBySession`）、按 viewer 投递（`sendToViewers`）、事件泵按 sid 路由（`dsh-events.js:231-235` `webTurnSessions`，注释原话「即使 session manager 已移走，并发 web turn 仍可见」）、每会话重放缓冲、以及客户端对 `session_loaded{running:true, turnEvents}` 的活流重建（`chat-store.ts:983-1140`）——「切走后台继续跑、切回看到活流」这条链路服务端与客户端都已打通，唯一拦着的是那一处 cancel。
2. **「单回合」今天其实只靠 UX 模式维持，宿主并未强制。** prompt 路径只有同会话守卫（`ws.js:448 isStreamingFor(promptHint)`），`beginTurnFor` 不停任何东西。两个浏览器 Tab 分别在会话 A、B 提问，今天就会把两个回合并发派进 dsh，踩进上面那个 wedge——线上「agent 卡在回答中不收尾」的零星现象可能源于此。

## What Changes

- **切会话 / 新建会话不再取消离开会话的进行中回合。** 该回合在后台继续；其事件照常进入该会话的重放缓冲并投给仍在看它的连接；用户切回时经既有 `session_loaded{running:true, turnEvents}` 重建活流并继续收流。`/new`、侧栏切换、深链、多 Tab 导航全部适用。
- **新增宿主级回合派发器（turn-dispatch）。** 运行时正忙（任一会话有进行中回合）时，另一会话的 prompt 进入 FIFO 队列——不被拒绝、也不并发派进 dsh；每会话至多一条排队项，总量有界；上一回合 `finishTurn` 后自动派发队首；排队中可取消（`stop_turn` 作用于排队项即出队，不触碰 dsh）。派发器成为「一次一个回合」的**唯一强制点**，顺带关闭双 Tab 并发隐患。
- **派发策略是一个可翻转的缝。** 默认策略「忙则排队」；当候选 dsh 通过严格版合同 ⑨（两会话回合均正常收尾到 idle）时，策略可切为「直接并发派发」而上层不改。本 change 只落「排队」策略；真并发的开启条件写进 spec，由 dsh 升级 change 消费。
- **排队态可见。** 侧栏逐会话显示回合状态（进行中 / 排队中）；排队中的会话在对话视图显示排队气泡（说明在等哪个会话、提供「停止该会话并立即执行」）。
- **删除保护扩展。** 「不能删除当前会话」扩展为「不能删除有进行中或排队回合的会话」（服务端 409 + 侧栏菜单禁用）——否则后台在跑的会话可被删掉（`chat-history.js:406` 只守全局指针）。
- **派发显式携带目标 sessionId。** `ctx.session.prompt(text)` 在 `expandDocRefs` 的 `await` 之后才读全局 `currentSessionId()`（`server.js:754` / `ws.js:495-496`），并发派发下会错归属；改为显式传 sid。
- **dsh-contracts：⑨ 增加严格「收尾交错」变体**，advisory 上报（不作门禁），作为 dsh 0.2.1-rc.2 spike 的判据与派发策略翻转条件。
- **BREAKING（协议语义）**：`switch_session` 不再隐含取消离开会话的回合。需要中止的客户端必须显式发 `stop_turn`。旧客户端行为退化为「切走后原回合继续跑」，无崩溃面。

非目标：多子进程 / 按会话独立 dsh 子进程（D4 Non-Goal 维持）；改动 dsh 插件模板或子进程；cron / bot 路径的派发（它们走各自 collector，是否纳入派发器留给设计讨论并明确结论）。

## Capabilities

### New Capabilities

- `turn-dispatch`: 宿主侧回合派发器——单回合强制点、FIFO 排队与上界、排队态播报（`queued` / `dequeued`）与取消语义、派发策略缝（queue vs concurrent）及其翻转条件（严格 ⑨ 通过）。

### Modified Capabilities

- `chat-streaming`: 「Stop and session-switch cancel the turn via the bridge」→ 仅用户显式停止经 `session/cancel`；切会话 SHALL NOT 中断回合。新增排队态在会话流中的呈现与 `stop` 对排队项的出队语义。
- `chat-history`: 「Users can switch the active chat session」整体替换（REMOVED + ADDED「…without disturbing in-flight turns」）→ 流中切换 SHALL 被允许且 SHALL NOT 影响任何进行中回合（原文「Switching SHALL be rejected while the agent is streaming」与代码早已不符，其场景名本身断言「拒绝」，故不原地反转而是替换）；「Server exposes a session delete endpoint」的 409 守卫扩展到有进行中/排队回合的会话。
- `web-chat-server`: 「Server accepts user prompts via WebSocket」→ prompt 交由 turn-dispatch 派发，「一次一个回合」由派发器强制而非 UX 模式。
- `live-runtime-control`: 「Bridge exposes real turn cancellation via session/cancel」→ 删去「切会话停流统一经此方法」，cancel 仅服务显式停止；「切会话不再重启」场景改写为「切会话不触碰回合」。
- `session-list-management`: 新增「侧栏逐会话回合状态指示」；「Active session cannot be deleted from the menu」扩展到进行中/排队会话。
- `dsh-contracts`: ⑨ 增严格收尾交错变体（advisory 行，不翻总判定），上报候选 dsh 是否支持回合收尾交错。

## Impact

- **服务端**：`server/agent-session.js`（`stopStreamingForSessionNavigation` 退出 `switchToSession` / `createNewSession` 路径，仅保留给显式停止）、`server/ws.js`（`prompt` 两分支接派发器；`stop_turn` 增排队项出队分支；`switch_session` 不再导航式停流）、`server.js:752-763`（session shim `prompt(text, sid)`）、`server/dsh-events.js`（`finishTurn` 后触发派发器 drain）、`server/context.js`（队列状态 + `sessions` 载荷的逐会话 status）、`chat-history.js:406`（delete 守卫）、`server/routes/chat-history.js`（REST delete 同守卫）。
- **客户端**：`packages/core/src/types/ws.ts`（`queued` / `dequeued` 事件；`sessions` 条目增 `turnStatus`）、`packages/core/src/store/chat-store.ts`（排队气泡态；`stop` 在排队态发 `stop_turn`）、`web/src/components/Sidebar.tsx`（状态指示、删除菜单禁用条件）、`web/src/components/Chat.tsx`（排队气泡）、i18n 词条。
- **合同**：`scripts/lib/dsh-contracts/contracts.mjs`（⑨ strict advisory 变体）；spike：`npm run dsh:contracts -- --tree <0.2.1-rc.2 scratch>`。
- **回归面**（D4 当年点名的三块 + 本次新增）：reconnect-resync（`resync:true` 路径语义不变但需复测）、session-ownership（跨用户 viewer 投递）、demo 配额（排队项是否计额）、e2e 流测试（`composer-stop.spec` 为 main 固有 flaky，基线先量）。
- **部署**：纯 cell 侧改动，随常规出片滚动；无 env / 网关 / dsh 矩阵变更。
