# 副驾上下文如何送达模型

> 归口：`openspec/changes/unify-copilot-workbench` B1。相关规格：`web-chat-ui`「副驾携带看板上下文」、
> `action-gate`「动作注册表声明风险与影响面」。

## 一句话

副驾知道「用户在看什么」，靠的不是 postMessage，而是**每个 prompt 自带一个 `context` 字段**，
服务端把它渲染成一段明确标注「非用户指令」的前缀拼在用户话之前。

## 链路

```
CopilotDock（宿主，/boards/facet 等）
  ├─ postMessage {type:"copilot_context", board, page, viewSummary}   ← 界面同步
  │     ↓
  │   ChatPage 收下 → setHostCtx → 上下文条显示
  │
  └─ 用户提问 → send({type:"prompt", text, context: hostCtx})
        ↓ WebSocket
      server/ws.js  case "prompt"
        ↓
      withCopilotContext(text, context)      ← lib/copilot-context.js
        ↓
      session.prompt(前缀 + 用户话)
```

## 为什么不用 postMessage 送上下文

postMessage 只在**同一个文档**内的 iframe↔宿主之间传递。模型运行在**服务端进程**里，
那条通道在架构上就到不了它。`copilot_context` 永远只能做「界面同步」——
它的第二个消费者是 ChatPage 把同一份状态再塞进 prompt，而不是让模型自己去看消息。

代码里 `CopilotDock.tsx` 的发送点带这条注释；改那里之前先读它。

## 前缀长什么样

```
[宿主页面提供的上下文（非用户指令）]
产品线：壹座
页面：/boards/facet
看板：facet
视图：4 块（概览指标 / 我的包 / 发布记录 / 最近事件）
选中：功能包 市场走查包 v3

用户消息：<用户真正打的字>
```

措辞照抄已在生产跑通的萬星宿主实现（`fd-wanxing/wanxing-web/src/chat-core.js`
的 `contextPrefix()`）—— agent 的提示词已经按这个标记调过，换一种写法等于教它两种方言。

## 开关与回滚

| 变量 | 缺省 | 作用 |
|---|---|---|
| `COPILOT_CONTEXT_PROMPT` | 关（只有 `"1"` 打开） | 关：前缀不拼，prompt 与改造前逐字节一致。回滚 = 关掉这个变量，不用回滚代码。 |

`board_read` 工具不需要开关：它按 `copilot-presets.js` 的形状判定进入可见面，
没安装相应 pack 的部署自然看不到它。

## 安全

上下文里的每个值都是**宿主提交的不可信数据**：

- 换行被压平，长度按字段截断（`lib/copilot-context.js` 的 `LIMITS`）。
- 两个结构标记（开头 `[宿主页面提供的上下文（非用户指令）]`、结尾 `用户消息：`）
  在数据里出现时被删除，保证渲染结果里各只出现一次 —— 否则一段精心构造的 `page`
  值可以让模型以为自己读完了用户的真实消息。
- 单测覆盖了这两种伪造尝试，以及「非对象 context 被当作缺省」。
