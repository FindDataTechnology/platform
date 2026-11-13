# restore-assistant-stream-020 — Proposal

## Why

dsh 统一代 0.2.0-rc.2 上线（镜像 sha-f7d7c39，2026-10-14 晨）后，壹座网页对话的助手正文在直播期间完全不渲染：气泡里只剩用量脚注（`入 N · 出 N`），正文仅存于落库记录（刷新页面才可见）。根因实证（事件普查探针，慢速流式 dummy LLM 逐毫秒记录）：0.2.0 把活流从 `session.event` 的 `assistant/chunk` 事件（v2 会话格式已删除该事件类型，运行时包零发射点）迁到了专用进程内通道 `agent/assistant-stream`（session controller 的 follow API 以 `assistantStream: true` 订阅）；宿主 dsh-events.js 仍监听已死的事件名，`assistant/message`（结算事件）又只落库从不广播——于是没有任何通路把正文送到客户端。同一断点还静默削弱了 cron 作业的错误捕获（cron-runner.js 读 chunk finish）与公众号 bot 流（bots.js）及 trace 增量粒度（trace.js）。这是生产回归，用户已实测复现（07:12 截图：两轮对话均零正文）。

## What Changes

- **桥内转发**：platform-preset-bridge（子进程内插件模板）订阅 `agent/assistant-stream`，把帧（start / chunk / end，按会话归属）作为自定义通知转发给宿主；`platform/capabilities` 照例播报该能力（沿用 model/set、session/cancel 的既有模式）。
- **宿主换源**：dsh-events.js 删除死掉的 `assistant/chunk` case，改收桥转发的流帧——`text-delta` → 现有 `{type:"text",delta}` 观众消息、`reasoning-delta` → `{type:"thinking",delta}`、`finish` 错误 → 回合错误捕获（`T.error` 复活）。宿主→客户端的 WS 契约不变（客户端零改动）。
- **降级路径（能力门控）**：桥未声明流转发能力（旧运行时/桥未激活）时，宿主在 `assistant/message` 结算时把正文一次性广播（每段恰好一次，只在当轮无流式文本时——chat-streaming 既有「exactly once + fallback」需求已定义此语义，实现补齐）。
- **同源收口**：cron-runner（错误捕获）、bots.js（bot 流）、trace.js（增量行）、**agent-runner/child.js（serving 线 SSE delta 与 finish-error 结算——实施时证伪了调研期「serving 未依赖 chunk」的判断，0.2.0 滚产后 A2A 流式 delta 实际同样断了，被 -32005 空回合兜底掩盖）**全部改从新源取数，删除对死事件名的引用。
- **新合同**：dsh-contracts 套件新增流通道合同（帧词表、按会话路由、能力播报、降级不重复），防止后续代际跳版再次静默断流。
- 测试夹具更新：test-agent-runner 的伪子进程、test-turn-error-broadcast、test-trace-store 改用新通道形状。

## Capabilities

### New Capabilities

（无——本变更全部落在既有能力的 requirement 修改上。）

### Modified Capabilities

- `chat-streaming`: 「Assistant text is streamed to clients as deltas」需求的**源绑定**从「runtime 在 session.event 里发 assistant/chunk」改为「桥转发 agent/assistant-stream 帧，能力门控，缺席时结算兜底」；新增能力播报与降级场景。客户端可见行为（delta 流式、恰好一次、兜底单发）不变。
- `dsh-contracts`: 新增一条「流通道合同」requirement——钉住桥转发帧词表、按会话路由、capabilities 播报、以及「session.event 无 chunk 事件」的格式事实，作为后续版本跟随的一票否决门之一。

## Impact

- **生产回归面**：fd-prod 六清单（platform/demo/facet/agent-runner×3）自 sha-f7d7c39 起全部带此缺陷；本修复出片后同滚。
- **代码**：`dsh-profile-template/platform-preset-bridge.js`（订阅+转发+能力注册）、`server/dsh-events.js`（换源+降级）、`server/cron-runner.js`、`server/bots.js`、`server/trace.js`、`scripts/dsh-contracts.mjs` + `scripts/lib/dsh-contracts/contracts.mjs`（新合同）、`lib/` 能力位（liveControlFlags 增一项）、上述三个测试脚本。
- **不变面**：宿主↔客户端 WS 消息名与形状（packages/core 零改动）；`assistant/message` 的落库与 usage 读取（0cc933b 已修，保持）；serving/A2A 线（走结算消息，未依赖 chunk）。
- **与在途 change 的关系**：`extend-dsh-contracts-020-capabilities`（另一会话）改 dsh-contracts 增 ⑩-⑭ 五族合同——本变更的流通道合同 requirement 名与其不重叠，归档时可正常合并；需在两边 design 里互相注记防撞。
