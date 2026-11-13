# chat-connect-guidance — 对话内连接引导

## Why

模型车道或 MCP 工具因凭据失败时，聊天里只有一条裸错误（"401 Unauthorized"、
"Invalid API key"……）：没有下一步。连接中心（L1）和词元账号线（L2a）已经把
「去哪里连」做成了深链卡片，但**用户在最需要它的那一刻——对话失败时——看不见它**。

这是四刀路线的 L3：把连接中心的存在感带进对话本身。

已有钩子：`dsh-events` 的 `markCredentialStaleOn401` 已按 `mcp__<server>__<tool>`
归因把失效凭据标 stale；`credential-refs` 的 `connectPathForRef` 已能映射
ref → `/settings/connections?panel=`。缺的只是把这条链路接到用户脸上。

## What Changes

- **服务端分类**：新模块 `server/connect-guidance.js`，两个入口：
  - `turnErrorHint(message)` — 模型车道失败文本命中凭据特征（401/403/invalid api key/
    unauthorized/credential）→ `{panel:"ciyuan-account"}`（L2a 后模型凭据的修复入口就是词元卡）。
  - `toolFailureHint(toolName, resultText)` — 失败工具 `mcp__<server>__*` 解析 server 配置 →
    `credential-refs.refFor` → `KNOWN_CONNECT_PANELS` 得 panel；解析不出 ref 则不附。
- **附着点（两处，均为加字段不改文本）**：
  - `platform/stream` finish-error → turn/end 广播的 `{type:"error"}` 增加可选 `connect`；
  - `tool/result` isError 广播的 `tool_end` 增加可选 `connect`。
- **客户端渲染**：`Block` 的 error 变体与 tool 变体增加可选 `connect?: {panel: string}`；
  `chat-store` 透传；`AssistantTurn` 错误块与失败工具块在消息下方渲染「去连接」按钮，
  深链 `/settings/connections?panel=<panel>`（既有高亮锚逻辑）。
- **不改动**：模型可读的 transcript 文本一字不动（引导是结构化旁挂，不是文本改写）；
  stale 标记链路照旧；持久化历史不带 `connect`（历史回放无按钮，属预期）。

## Non-goals

- 不做自动重试/自动弹窗；不改错误文本本身；不覆盖非凭据类错误。
- 不做模型侧引导（给模型看的工具结果文本不加提示——那是 tool-discovery 层的既有模式，
  凭据问题模型解决不了，引导只给人看）。

## Impact

- 代码：`server/connect-guidance.js`（新）、`server/dsh-events.js`（两处附着 + 与
  stale 检测共享 server-config 解析）、`packages/core/src/store/chat-store.ts`、
  `web/src/components/AssistantTurn.tsx`、i18n 五语言。
- 兼容：旧客户端收到多余字段忽略；新客户端对旧服务端（无 connect）不渲染按钮。
