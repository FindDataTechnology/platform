# Proposal: fix-gateway-bot-owner

## Why

生产 E2E 实证缺陷(台账 §15.23 补记):多租户网关把 bot webhook 路由到属主 cell 时,`gateway/bot-webhooks.js` 的 `ownerEmailOf` 用 `chat_sessions.owner LIMIT 1` **任取**会话属主——混合登录史的 cell(旧账号会话+新账号会话并存)会把 webhook 指到**没有该 bot 的错误属主 cell** → 403。bot 实际所在的 cell 是明确的(按 botId 扫到的那个 db),错的只是从会话推断的属主邮箱。

## What Changes

- **bots 表加 `owner_email` 列**(幂等迁移,version 101):建 bot 时写入创建者邮箱(`POST /api/bots` 的 `req.user.email`;存量行 NULL)。
- **网关解析优先 bot 行属主**:`bot-webhooks.js` resolve 读 `owner_email`——非空即用;NULL(存量 bot)回落既有 `ownerEmailOf`(会话推断),行为兼容。
- 建号响应与列表(maskBot)不暴露该字段(内部路由用,非展示面)。

## Capabilities

### New Capabilities
(无)
### Modified Capabilities
- `social-bot-channels`: MODIFIED——多租户 webhook 路由的属主判定:优先 bot 行的创建者邮箱(建号时记录),会话推断降为存量行回退;混合登录史 cell 不再指错属主。

## Impact

- 代码:`db.js`(迁移 101 + addBot/语句)、`server/routes/bots.js`(创建时传 owner)、`gateway/bot-webhooks.js`(resolve 读 owner_email 优先)。
- 测试:`test-bots.mjs` 或新用例钉 owner_email 写入;gateway resolve 单测(owner_email 优先/回退/两无 404)。
- 出片:gateway 与 cell 同镜像,随下一班;**存量 bot 回退语义=不修复旧 bot**(生产当前无在用 cell bot,实证),新建设 bot 即正确。
- 非目标:不改 webhook 鉴权面;不做存量 owner 回填脚本(生产无此需求实证)。
