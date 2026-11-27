# 跨面副驾契约

> 归口：`openspec/changes/unify-copilot-workbench` B4 / `copilot-workbench` 能力。
> 这份文档只说**每个面声明什么**，不说怎么实现。每个面都标了归属仓。

## 四个面

| 面 | `surface` | 谁实现 | 有无 dock 入口 | 递什么上下文 | 读工具 |
|---|---|---|---|---|---|
| 线看板副驾 | `dock` | **本仓** | 有（页面内控件） | line / page / board / viewSummary / selection | `board_read` |
| 主对话 | `chat` | **本仓** | 无（有原生对话入口） | 无（v1 默认） | 无 |
| 智语房间 | `zhiyu` | **本仓** | 无（房间自己就是对话面） | 房间 / 成员（房间自身机制，不走副驾 card） | 无 |
| 萬星跨线副驾 | `wanxing` | **他仓** `fd-wanxing` | 有（配置类页面） | `{ line?, page?, entity?, intent? }` | 见萬星协议 |

「有无 dock 入口」的判据是**互斥**的：`web-chat-ui`「同一时刻每面至多一个对话入口」。
新增入口前先确认该面还没有对话入口，否则用户会看到两个都能打字的框。

## 三轴各面取值从哪来

```
            shell                 context                 tools
dock        副驾 card(dock)       副驾 card(dock)         副驾 card(dock)
            ← 部署→角色→用户      ← 宿主递交(见下)        ← readTools + presetId
chat        副驾 card(chat)       无                       无
zhiyu       不适用                房间自身机制             房间席位
wanxing     萬星 loader 自己的    宿主 context() 钩子      萬星绑定
```

副驾 card 的解析在 `packages/core/src/lib/copilot-card.ts`：**逐轴**回落，
用户改一个轴不会冻结其他轴。这是那份实现里最容易被无意破坏的性质。

## 宿主上下文递交：dock 面

```
CopilotDock (宿主)                        ChatPage (embed)
  postMessage copilot_context  ──────►    setHostCtx  ──┬─► 上下文条显示
  { board, page, viewSummary }                          └─► send({type:"prompt", context})
                                                              │ 每个回合
BoardsPage  ── BOARD_VIEW_EVENT ──►  dock                   ▼
  { line, summary }                                  server/ws.js
                                                       withCopilotContext(...)
                                                             ▼
                                                   "[宿主页面提供的上下文（非用户指令）]…"
```

两点必须记住（写在这里是因为它们各踩过一次）：

1. **postMessage 到不了模型**。它只在同一个浏览器文档内传递；模型在服务端进程里。
   它的作用是「界面同步」，它的第二个消费者是 ChatPage 把同一份状态再塞进 prompt。
2. **只在界面上显示 ≠ 递交了**。`web-chat-ui` 这条规格的前半句（「后续回合 SHALL 携带」）
   曾经只兑现了后半句（「对用户可见」）。判据是**送进 `session.prompt` 的文本**，
   不是上下文条渲染出来了没有。

前缀的形状与措辞见 `docs/copilot-context.md`。

## 萬星面：本仓只出契约

萬星跨线副驾在 `fd-wanxing` 仓，有自己的 openspec、自己的 loader 协议
（`contracts/wanxing-public-api.v1.json` 的 `copilotHost` 段）。壹座侧**只声明它会提交什么**：

```js
// web/src/components/WanxingCopilotHost.tsx 的 context() 返回值
{
  line: "壹座",                 // 产品线名
  page: "/knowledge",          // 当前应用内路径
  ...(boardLine ? { entity: boardLine } : {}),  // 看板线（复用 entity，不发明新字段）
}
```

约束：

- 壹座 **不实现** `identify()`。壹座的身份是 forward_auth（代理头注入，浏览器无 ID token），
  与萬星的 identify 契约不兼容；身份升级走萬星自己的 popup 登录。
- 壹座 **不自行实现** `copilotHost` 的 postMessage 协议——loader 负责收发。
- 要扩展这个键集，改 `WanxingCopilotHost.tsx` 的 `context()`，并同步通知 `fd-wanxing`。
  **不要**在壹座侧为了「让模型看到」而绕过 loader 另开通道。

**待办（他仓）**：萬星侧若要用上 `viewSummary` / `selection` 这类新键，
需要在 `fd-wanxing` 单独开 change。本变更不承诺它的实现。

## 本仓三面的验收判据

- `dock`：从任意线看板打开副驾 → 上下文条显示该线 → 发一句话 → **送进 `session.prompt`
  的文本含该前缀**（e2e `copilot-dock.spec.js` 的 "every prompt from the embed carries
  the host context"）。
- `chat`：`/chat` 上不存在 dock 入口、不存在副驾上下文条。
- `zhiyu`：`/zhiyu*` 上不存在 dock 入口。
