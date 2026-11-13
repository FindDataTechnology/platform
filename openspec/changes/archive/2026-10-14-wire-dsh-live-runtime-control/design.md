# Design: wire-dsh-live-runtime-control

## Context

dsh（@deepseek-ai/dsh@0.1.1-rc.2）子进程与宿主之间只有三个线上 RPC（initialize / session/prompt / shutdown），provider/model 烧死在 initialize 握手里，因此 paas 把切模型、切会话停流、假停止全部实现为「重启子进程」。调研（2026-10-13）确认 dsh-agent 的**公开导出面**已有活控制原语：`agent/request` waterfall（逐请求替换 LlmCallConfig）、`installModelSelection`（官方活切原语，step 边界快照）、`agent.cancel(cause)` / `whenIdle()`（真中断）、按 sessionId 的多 agent 并发驱动（`ctx.agents.create`，`session.status` 按会话播报）。`platform-preset-bridge.js`（dsh-profile-template，我们的插件模板）已在子进程内覆写 `handleRequest`（`presets/list` 先例），是天然的自定义 RPC 挂载点。动机与问题清单见 proposal.md。

## Goals / Non-Goals

**Goals:**

- 切模型、停流、联网开关全部免重启，毫秒级生效
- 多会话真并发：一个会话跑流不阻塞另一会话收发
- 停止按钮成为真中断（服务端停止，而非视图级吞事件）
- dsh:contracts 钉住新消费面，rc 升级不静默断裂

**Non-Goals:**

- 不做 per-session 独立子进程 / 资源配额隔离（仍是单子进程多 agent）
- 不动 subagent 委派链路、BYOK relay 配线语义
- 不实现 dsh 上游改动（全部经我们自己的插件模板完成）

## Decisions

### D1: 自定义 RPC 挂在 platform-preset-bridge 的 handleRequest 覆写里

宿主 `dsh-bridge.js` 经既有 stdio client.request 发送，子进程侧在桥类 `handleRequest` 增补 `model/set`、`session/cancel`、`tools/set` 三个方法（沿 `presets/list` 的既有模式）。
**备选否决**：fork dsh-sdk-jsonrpc-server（升级即分叉漂移）；上游提 PR 加通用 RPC（节奏不可控，且这三条是平台语义不是通用语义）。

### D2: 模型活切用 agent/request 瀑布读活值（实现修订）

桥的 `createSession`（已覆写）在 agent 创建后于 agentCtx 注册一个 `agent/request` waterfall 监听器，从可变 ref（`#selections` 会话记录）读**当前值**替换请求配置的 provider/model/reasoningEffort；`model/set {sessionId?, provider, model, effort?}` 置 ref（未创建会话则 park 至创建时播种）。请求粒度即 step 边界：已发出的请求不受影响，下一个请求生效。
**设计订正（实施中发现）**：原案首选的 `installModelSelection` 其 agent/request 腿应用的是 `system-prompt/assemble` 的快照值（`selection.assembled`），而 SDK 创建的 agent 的 prompt 组装是会话级缓存——切换后不再重新快照，路由永远停旧模型（合同⑦实证：`applied:true` 但 assembled 恒旧）。故改用直接读活值的自有 waterfall；effort 语义沿用 dsh 的「absent 即清除继承值」。
**备选否决**：fork dsh-sdk-jsonrpc-server（升级即分叉漂移）；上游提 PR（节奏不可控）。

### D3: 停止与切会话停流改走 session/cancel → agent.cancel(cause)

宿主 `stopStreaming`（用户停止）与 `stopStreamingForSessionNavigation`（切会话）统一为发 `session/cancel {sessionId}`，子进程侧 `agent.cancel(cause)` + `whenIdle()` 收敛回执；`promptStoppedByNavigation` 标记及「重启杀子进程」路径退役（cwd/preset 切换仍走 restart，属既有契约）。
停止语义升级为真中断后，客户端 `suppressed` 吞事件机制可保留（幂等防御）但不再是正确性依赖。

### D4: 宿主流状态按会话分键

`ctx.isStreaming`（布尔）→ 按 sessionId 的 Map；守卫、`turnOrigin`、`turnBuffer`（context.js 分键）、`done`/error 路由全部随会话键。dsh 事件与 `session.status` 已按会话播报，映射层（dsh-events.js）本就是逐事件带 sessionId 的。全局 broadcast 类事件（models/sessions 等）不变。
**顺序**：先落 RPC 面（D1-D3），再拆全局状态（D4）——前者独立可验，后者回归面大（重连 resync、session-ownership、demo 配额）单独一轮 e2e。

### D5: 联网开关 = guard 层动态闸 + tools/set；默认关是部署动作

`tools/set {sessionId, server, enabled}` 翻 `installMcpToolGuard` 所辖的会话级服务名单（guard 是调用时拦截，天然免重启；register-shadow 的注册期裁剪不适用于动态翻转，保持只管静态面）。会话默认值取平台默认（关）；fd-prod 撤 `PACK_BASELINE_MCP` 中的 websearch 完成默认翻转。控制条开关芯片读写该状态，`web-search` spec 的「零配置默认开启」需求 reshape。

### D6: usage 通道 = done 载荷 + 回合脚注 + 水位条

`dsh-events.js` 在回合结束时把该回合最后一步 `assistant/message` 的 `data.usage`（inputTokens/outputTokens）附加到 `done` 事件载荷（additive，旧客户端忽略）；回合脚注渲染 in/out。上下文水位 = 当前会话各回合 usage 输入累计 ÷ 模型 `contextWindow`（roster 已带字段），显示于输入框旁。精确 context 长度（dsh 侧快照）非目标，水位为近似。（修订 2026-10-14：原稿写 finish chunk 携带 usage——形状错配，真回合实证 TokenUsage 只在 assistant/message 上，finish chunk 无此字段；cron-runner 同错同修，见 0cc933b。）

### D7: 客户端防重三件套

① 提交闭锁：`submit()` 进入即置 in-flight ref，`user` 回显或超时释放，挡 Enter 键重复与陈旧闭包竞态；② prompt 发出即置本地 pending 态（用户气泡挂进行中指示，`agent_start` 到达前就可见），消除重发盲窗；③ `canSend` 纳入 `isStreaming`（服务端拒绝兜底保留）。D4 落地后 `isStreaming` 订阅按当前会话取值。

### D8: 能力探测与降级

桥 initialize 握手回执（或首个 `presets/list` 应答）携带能力声明（`capabilities: ["model/set","session/cancel","tools/set"]`）；宿主缺失时回落既有 restart 路径并照旧禁流中切换。保证子进程/宿主版本错配（滚动窗口、旧镜像）不炸，只退化。

### D9: dsh:contracts 增合同

新增活控制合同：活切模型（流中 model/set 下一 step 生效、当前请求不撕裂）、cancel（活跃回合中断并收敛 idle、inbox 语义）、多会话并发（两 session 各自 prompt 互不阻塞）。按 ADR-0007，三者在 dsh-agent 为公开导出（非 internal-API 标签），但 rc 节奏下仍入套件钉住。

## Risks / Trade-offs

- [rc 升级改变 waterfall/cancel/ModelSelection 行为] → D9 合同先行，fail 即不跟版（ADR-0007 既有流程）。
- [rc.2 已知限制：回合收尾不与另一会话的挂起请求自由交错] → 平台不消费该行为（宿主单回合 + 切换走取消）；合同⑨收窄为派发并发并如实标注，上游演进后升格。
- [SDK agent 的 prompt 组装会话级缓存，installModelSelection 快照链失效] → D2 已订正为直接读活值的 agent/request 瀑布（合同⑦在 wire 上实证路由切换）。
- [多会话并发放大单子进程负载与上游 LLM 并发] → 并发上限护栏（按会话 Map 容量 + 提示排队），观测 turn-telemetry 后再定阈值。
- [D4 按会话改造回归面大：重连 resync、ownership、demo 配额] → 拆独立切片，全量 e2e + 灰度；D4 前的 RPC 面独立可发。
- [websearch 默认关改变既有用户预期] → 会话开关常驻控制条，开关态持久于会话；发布说明明示。
- [turnBuffer 分键内存上界] → 每会话沿用既有 2000 事件/1MB 上界 × 会话数封顶（LRU）。
- [宿主/子进程版本错配窗口] → D8 能力探测降级，行为回到现状而非报错。

## Migration Plan

1. 模板（platform-preset-bridge）+ 宿主（dsh-bridge/ws/agent-session）同 PR 出片，D8 探测保证滚动窗口内新旧共存只退化。
2. 部署后撤 fd-prod `PACK_BASELINE_MCP` 的 websearch（独立环境动作，可单独回滚）。
3. D4（按会话状态）作为第二片单独滚动；回滚 = revert 该片，RPC 面不受影响。

## Open Questions

- 水位条的累计口径（纯输入 token 还是 in+out）——UI 细节，实施 chat-usage-display 时定，不影响架构。
