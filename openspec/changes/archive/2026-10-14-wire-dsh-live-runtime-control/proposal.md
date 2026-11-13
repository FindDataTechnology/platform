# Proposal: wire-dsh-live-runtime-control

## Why

壹座对话面（platform.finddatatech.cloud）集中爆发五类体验问题，用户实测反馈：①切模型耗时极长且流中被禁止；②联网搜索无开关、默认常开；③看不到 token/上下文用量；④会连发两条相同消息；⑤切到另一会话后发送失败。调研证实根因是**集成的错觉天花板**：dsh 运行时（@deepseek-ai/dsh@0.1.1-rc.2）原生具备活切模型（`agent/request` waterfall / `installModelSelection`）、中断回合（`agent.cancel`）、多会话并发（按 sessionId 寻址的 agent 驱动）能力，但 SDK 线上协议仅暴露 initialize/session/prompt/shutdown 三个 RPC，paas 因此用「重启子进程」实现一切切换——慢、杀流、且把全局单回合状态强加给所有会话。我们自有的 `platform-preset-bridge` 插件运行在 dsh 子进程内部且已覆写 `handleRequest`，可以低成本暴露自定义 RPC 打通这些原生能力。

## What Changes

- **新增自定义运行时控制 RPC**（`platform-preset-bridge` 模板内实现，宿主 `dsh-bridge.js` 增加调用面）：
  - `model/set`——活切 provider/model/reasoningEffort，替代切模型时的整进程重启；流中切换由 dsh 原生 step 边界快照保证安全（下一 step 生效）。
  - `session/cancel`——真·停止按钮与切会话停流，替代「重启杀子进程」；`stopStreamingForSessionNavigation` 不再 restart。
  - `tools/set`——会话级工具闸翻转（联网搜索开关），经既有 guard 层动态生效，免重启。
- **宿主按会话改造**：`ctx.isStreaming` 全局单回合 → 按会话（dsh 事件已携带 sessionId）；turnBuffer 按会话分键；切会话即时完成，A 会话跑流不再阻塞/拒绝 B 会话的发送。
- **联网搜索默认关 + 每会话开关**（用户拍板）：fd-prod 撤 `PACK_BASELINE_MCP` 中的 websearch；输入框控制条增加会话级联网开关，默认关，经 `tools/set` 生效。**既有「零配置默认开启」需求反转（reshape）**。
- **token/上下文显示**：`done` 事件携带回合 usage（finish chunk 的 inputTokens/outputTokens，trace 通道已有数据）；回合脚注显示 in/out；输入框旁显示累计上下文对 `contextWindow` 的水位（roster 已带该字段）。
- **重复消息三重防线**（纯客户端）：提交闭锁（in-flight ref 防 Enter 重复触发竞态）；prompt 发出即进入 pending 态（消除「气泡已上屏但无进行中反馈」的盲窗重发）；`canSend` 纳入 `isStreaming`。
- **dsh:contracts 合同面扩充**：为新消费的公开导出（`agent/request` waterfall、`agent.cancel`、`installModelSelection`）增加合同覆盖，钉住 rc 升级节奏下的行为。

## Capabilities

### New Capabilities

- `live-runtime-control`: 自定义 RPC 面（model/set、session/cancel、tools/set）的桥接契约——宿主何时调用、子进程插件如何映射到 dsh 原生 API、失败与版本不匹配时的降级行为。
- `chat-usage-display`: 回合 token 用量与上下文水位显示——done 事件 usage 载荷、回合脚注、contextWindow 水位条。

### Modified Capabilities

- `model-selection`: 「流中禁止切换」需求改为活切（下一 step 生效）或按回合排队；切换不再携带子进程重启与 pendingConfig 禁发窗。
- `chat-streaming`: 流守卫从全局改为按会话；停止从「视图级假停」改为经 `session/cancel` 的真中断；切会话不再杀流。
- `chat-composer-controls`: 控制条增加会话级联网搜索开关（默认关）；提交闭锁与 pending 态防重复发送。
- `web-search`: 「零配置默认开启」reshape 为「默认关、每会话可开」（REMOVED+ADDED）；开关经会话级工具闸动态生效。
- `dsh-contracts`: 六合同之外新增活控制合同（模型活切、取消、多会话并发语义）。

## Impact

- **代码**：`dsh-profile-template/platform-preset-bridge.js`（新 RPC 处理器）、`dsh-bridge.js`（调用面 + 不再依赖 restart 的路径）、`server/agent-session.js`（switchModelTo/stopStreamingForSessionNavigation 重写、按会话状态）、`server/ws.js`（按会话 isStreaming 守卫、prompt 路由）、`server/context.js`（turnBuffer 分键）、`server/dsh-events.js`（done 载荷带 usage）、`packages/core/src/store/chat-store.ts` + `web/src/components/*`（pending 态、防重、开关、用量显示）。
- **部署**：fd-prod 撤 `PACK_BASELINE_MCP=websearch`（环境动作）；profile 模板变更随镜像出片滚动。
- **风险**：消费面从「3 个稳定 RPC」扩至 dsh-agent 公开导出面——rc 版节奏下靠 dsh:contracts 新合同钉住；按会话状态改造是最大单块工程（事件流已带 sessionId，底子具备）。
- **非目标**：不实现 per-session 独立子进程/资源隔离；不改 subagent/委派链路；不动 BYOK relay 配线语义。
