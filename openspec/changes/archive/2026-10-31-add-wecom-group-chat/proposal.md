## Why

今天的 WeCom 通道只能做**自建应用 1:1 单聊**：`chatKey` 取 `FromUserName`，回复走 `message/send` 的 `touser`。企业微信里绝大多数协作发生在**群聊**，用户在群里 @ 一个机器人提问是这个平台最自然的用法；单聊通道把智语关在了私聊窗口里。

这一条现在是有条件做的：企微在 2025 年后提供了「智能机器人」，官方文档明确支持**群聊 @机器人 触发**、回调里带 `chattype: single|group` 与群 `chatid`、支持 `response_url` 被动回复。适配器已有的 AES 解密、签名校验、`tokenFor` 取 token 全部可复用，缺的是群聊这条支路的会话标识、@提及剥离与回复路由。

## What Changes

- 新增 bot 类型 `wecom-bot`（智能机器人），与现有 `wecom`（自建应用）并存：两者共用加解密与签名实现，但回调报文形状与回复通道不同。
- 入站解析按 `chattype` 分流：`group` 时 `chatKey` 取 `chatid`（会话级，而非发送人），`single` 时保持成员级；群聊消息剥掉 `@机器人` 的提及前缀后再交给 agent。
- 群聊回复走机器人回复通道（优先 `response_url` 被动回复，超时窗后回落 `appchat/send`），单聊保持 `message/send`。
- 会话 id 派生不变（`bot-<botId>-<sha1(chatKey)[:16]>`）：群 `chatid` 天然给出"一个群一个连续会话"，无需改 `social-bot-channels` 的会话模型。
- 管理面：`/settings/channels` 的图标网格增加该类型，凭据字段为corpId + 机器人 ID/Secret/Token/EncodingAESKey（具体字段以企微后台为准），并与自建应用在 UI 上明确区分（同为企业微信，能力不同）。
- **不改**：现有 `wecom` 自建应用的任何行为；bot 车道的守卫（长度上限、限流、工具姿态、待答问询）对群聊一律沿用。

## Capabilities

### New Capabilities

（无——群聊能力是 `social-bot-channels` 的一个新平台支路，不是独立能力域，按仓库现有组织不新开 spec 目录。）

### Modified Capabilities

- `social-bot-channels`: 入站 webhook 支持的企业微信不再只有自建应用单聊，新增「智能机器人」类型并区分群聊/单聊两种 `chatKey` 语义与两条回复通道；同时把本班修掉的两个观测性/健壮性事实写进需求（回复成功必须留痕、冷启动窗口内的 webhook 不得以确定拒绝丢消息）。

## Impact

**代码**
- `server/bots/wecom-bot.js`（新）：智能机器人适配器，复用 `wecom.js` 的 `decrypt`/`signature`/`tokenFor` 形态。
- `server/bots/adapter.js`：`BOT_TYPES` 增加 `wecom-bot`，注册表与凭据字段声明。
- `server/bots.js`：群聊场景的提及剥离；`reply()` 已有净化与留痕无需改。
- `server/routes/bots.js`：无结构改动（webhook 路由按 `botId` 分派到适配器）；凭据校验分支加新类型。

**外部依赖 / 配置（需要在企微后台做，属于发布前置）**
- 在企微管理端创建「智能机器人」，取得回调 URL / Token / EncodingAESKey，并把我们的 webhook 地址登记进去。
- 群机器人 **webhook（群机器人配置里的 Webhook 地址）不可用于本需求**：官方文档明确它只支持出站推送、不支持接收群消息。两者不要混淆。
- `appchat/send` 作为回落通道时有企业侧限制（仅自建应用可调、可见范围须为根部门），若不可用则该回落分支如实失败并留日志，不得静默丢回复。

**风险**
- 智能机器人的回调报文与自建应用不同，且文档对"是否共用同一回调 URL"未作说明——**必须先做一次真实报文抓取再定字段映射**，不能照自建应用的结构硬写。
- 群聊里 @机器人 才触发；非提及消息平台不会回调，因此不存在"监听整群"的意外行为，这同时是我们的隐私边界，必须写进 spec。
- 群聊意味着多人可见：`BOTS_ALLOW_TOOLS` 的工具姿态与回复内容在群里传播面更大，默认仍应保持与单聊一致的最严姿态。
