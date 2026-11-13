# Design: fix-gateway-bot-owner

> 生产 E2E 实证缺陷的聚焦修复(台账 §15.23 补记)。三处小改,一次出片。

## D1 · 迁移 101:bots.owner_email

`db.js` migrations 追加 version 101:`ALTER TABLE bots ADD COLUMN owner_email TEXT`(幂等先例照抄)。`addBot` 签名增 `ownerEmail`,INSERT 带列(NULL 兼容存量)。

## D2 · 创建面写属主

`server/routes/bots.js` POST /api/bots:`bots.addBot({..., ownerEmail: req.user?.email ?? null})`——requireAdmin 已在前面,req.user 必有。patch 不改属主(bot 不换主人)。

## D3 · 网关 resolve 优先行属主

`gateway/bot-webhooks.js`:SELECT 加 `owner_email`;`bot.owner_email` 非空 → entry.email 直接用它;NULL → 既有 ownerEmailOf 回退。缓存语义不变。schema 漂移防护既有 try/catch 覆盖(旧列缺失的 db 走回退)。

## D4 · 测试

- `test-bots.mjs` 补:创建后(以 admin 会话)db 行 owner_email=创建者;
- gateway resolve 单测:临时双 cell db(A 有 bot+owner_email、B 有会话属主他人)→ resolve 返回 A 的 owner_email 而非 B 会话推断;存量行(NULL)回落会话推断;两无 → null(404 路径)。放 `scripts/test-bots-event-wake.mjs` 或独立小套件——随 `test-bots.mjs` 附挂最省。

## D5 · 出片与复验

镜像滚完后公网复验:重建 bot+边(与 §15.23 同配方)→ 公网 webhook POST → 200 → O1 source=event。这是缺陷修复的最终闭环证据(上轮以直连 cell 完成的部分补全网关跳)。
