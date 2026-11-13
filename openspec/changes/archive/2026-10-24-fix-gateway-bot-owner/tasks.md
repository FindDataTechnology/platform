# Tasks: fix-gateway-bot-owner

## 1. 实装

- [x] 1.1 `db.js`:迁移 101(bots.owner_email,幂等 ALTER)+ addBot 增 ownerEmail 写入;`server/routes/bots.js` POST 传 `req.user?.email`;验证:建号后行值断言
- [x] 1.2 `gateway/bot-webhooks.js`:SELECT owner_email,非空优先/NULL 回退 ownerEmailOf;验证:resolve 三态单测(行属主优先/存量回退/两无 null)

## 2. 测试与出片

- [x] 2.1 测试用例落地(test-bots 补挂)全绿;既有套件零新增红;validate 通过
- [x] 2.2 出片随下一班镜像 → 公网复验全链(重建 bot+边→公网 webhook→200→O1 source=event,缺陷闭环证据)→ 台账补记
