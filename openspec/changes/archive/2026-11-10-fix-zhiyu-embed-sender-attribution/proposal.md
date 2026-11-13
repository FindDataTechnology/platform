# fix-zhiyu-embed-sender-attribution

## Why

移动视口浏览器眼（2026-11-10 13:03，公开演示房）拍到：访客看到的历史里有一条问题「你好，请用一句话介绍智语是什么。」被渲染成**「我」**、右侧主色气泡——而那条消息是 2026-11-07 由**另一位访客**（`mem_60f361a40c…`）发出的。

原因在 `web/src/pages/ZhiyuEmbedPage.tsx:253`：

```tsx
const mine = row.kind === "human" && row.fromAgent !== true;
```

判据只看"是不是人类消息"，**不看发送者是谁**。接待房天然是多访客场景（演示房现有 22 个 guest 席、15 条人类消息来自 14 个不同发送者），于是每个访客都会把别人的提问读成自己的话。这违反 `zhiyu-room` 既有要求「消息流与发送者归因」——每条消息 SHALL 携带发送者身份；实现却没把身份用上。

## What Changes

- 归属判据改为**按发送者成员 id 比对当前访客席**：`row.senderMemberId === visit.memberId` 才算「我」。
- 非本人的人类消息 SHALL 显示其真实署名（服务端已回填 `sender.display`，guest 为「访客 · <域名>」），不再冒充访客本人。
- 自己没铸过席（`visit` 未就绪）时，任何人类消息都 SHALL NOT 渲染为「我」。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无——`skip_specs: true`。`zhiyu-room` 的「消息流与发送者归因」要求本来就在，本单只让实现符合它，不改契约。）

## Impact

- 代码：`web/src/pages/ZhiyuEmbedPage.tsx` 一处判据 + 署名回退分支。
- 测试：无 React 单测设施；以移动视口浏览器眼复验（另一访客的历史消息应显示其署名而非「我」）。
- 不改服务端、不改 schema、不影响站内房间页（它按 `senderMemberId` 与 `myMemberId` 比对，本来就是对的）。
