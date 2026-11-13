# add-facet-copilot — Design

## Context

2026-10-22 上产的 copilot-dock-focused-preset 已把「副驾按线注入聚焦预设」做完整：`lib/copilot-presets.js` 按形状（allowTools 非空、无写工具、服务器属该线、agent 已 materialize）解析每线聚焦助手，`GET /api/boards/:line/copilot` 供 dock 取用，iframe `/chat?embed=copilot&board=&preset=` 应用预设并在关闭后恢复，动作闸保证写操作走提议-确认-审计。`facet` 线适配器与「谦面助手」官方 pack 均已注册。本 change 只做接线与内容打磨。

（上一轮 explore 曾定「iframe 嵌萬星 #/embed」方案——被本次考古推翻：壹座同源 dock 栈已完整覆盖且无跨域/计费新面，萬星车道是另一个宿主的方案，不需要。）

## Goals / Non-Goals

- Goals：Market tab 向导入口、聚焦预设注入、pack 上下文注入（只读）、谦面助手 pack 四类问题打磨。
- Non-Goals：匿名向导（计费决策后置）、frontend action、萬星 embed、新端点。

## Decisions

### D1 入口 = 既有 CopilotDock 的路由上下文扩展，非新浮层

`CopilotDock` 已从 `location.pathname` 推导 board 上下文（`/boards/:line`）。扩展：pathname 为 `/agents` 且 `?tab=market` 时同样推导 `line=facet`。不新建第二 FAB——一个全局副驾入口，上下文随路由变。市场 tab 内的引导文案（无助手时指向助手 pack 的市场条目）由 `PackMarketView` 顶部提示条承载。

### D2 pack 上下文 = 复用 postMessage 通道，事件源是详情弹窗生命周期

`PackDetailDialog` 打开/关闭（与 tab 内浏览态）经一个轻量模块级 emitter 广播；CopilotDock 已有的 same-origin postMessage 机制追加 `pack` 字段（id/name），ChatPage embed 上下文条渲染。**只读边界**：消息单向 dock→iframe，embed 侧不注册任何页面操作 handler——写意图仍只能经 `propose_action` 走闸（action-gate spec 既有约束自然继承）。

### D3 预设解析零改动：`facet` line + 谦面助手 pack 形状已合

`GET /api/boards/facet/copilot` 现网即答（LINE_BOARDS_ENABLED=1 生产实证）。谦面助手 pack（agent id `facet-assistant`，2026-10-22 v2 唯一 id 规范已修）满足形状判定即自动成为聚焦预设；不满足（如引用了写工具）按现有规则解析为 null → 降级为未聚焦明示。服务端唯一新增是路由上下文的**前端**推导，后端零改动。

### D4 助手 pack 内容 = 四类问题的技能化

谦面助手 pack v2 的技能面收编：①概念（pack/skill/MCP 引用/persona、订阅 vs 安装）；②推荐（按用途问诊 → 指向市场条目，市场数据只读可见）；③权限解释（allowTools/工具面披露 spec 的口径）；④安装引导（壹座一键订阅→对话运行时；CLI `facet install`→Claude Code/Cursor 两条路径）。事实来源锚定 `cliFacts.ts` 与 pack-marketplace spec 既有披露面——助手不引入新事实源，防漂移。

### D5 匿名出圈是定案不是遗漏

facet 独立站匿名向导涉及计费（免费车道=平台付 token）与限流设计，须用户拍板；壹座侧先行验证价值，有人用再立匿名面提案。

## Risks / Trade-offs

- 预设是 cell 级（dsh 烘焙于 initialize）——dock 打开期间整个 cell 在谦面助手预设上，主对话 agent 选择器可见该切换（既有语义，copilot-dock-focused-preset 已接受并做诚实）；Market tab 用户可能同时在主对话用别的 agent——关闭 dock 即恢复，与看板路径行为一致。
- pack 上下文 postMessage 是新的小协议面——字段固定（id/name/version），emitter 单向，无 ack、无请求响应。

## Open Questions

- 无。
