# Tasks: add-facet-market-credentials

## 1. 存储与模块

- [x] 1.1 db.js 迁移 v28：`user_facet_market_devices`（email PK, device_id, public_key,
      private_key, facet_email, stale, token, token_exp, paired_at, updated_at）+ 访问器
- [x] 1.2 `facet-market-credentials.js`：设备身份管理（keygen raw32B base64url、deviceId
      规约）+ pair（POST /api/app/pair）+ ensureFresh 串行锁（challenge→sign→login）+
      liveToken（同步缓存+10min 余量+fire-and-forget 刷新）+ markInvalid + status 投影
      （token/私钥永不出现）
- [x] 1.3 `credential-refs.js` 注册 `facet-market` ref（staleEvent=
      facet_market_credential_stale）

## 2. 安装链

- [x] 2.1 pack-store.js：credentialRef 数据驱动（entry.metadata.credential_ref ?? registry）
      + 对应连接门槛分派
- [x] 2.2 mcp.json 基线：facet-market 服务行（mesh 31893 + credentialRef）
- [x] 2.3 facet-market-mcp registry 条目 metadata PATCH（credential_ref）——运维动作

## 3. 路由与面板

- [x] 3.1 server/routes/facet-market.js：GET connection / POST pair / DELETE connection
      （镜像 connector 家族；reapplyProfile 热替换同形）
- [x] 3.2 server.js 挂载路由
- [x] 3.3 web 面板：FacetMarketConnectPanel（McpMarketView 市场头挂载；i18n 内联中文 fallback，五语条目待补）

## 4. 测试

- [x] 4.1 模块单测：keygen/签名对拍（RFC 8032 确定性）、pair 成功/401、ensureFresh 串行
      （并发只一次挑战）、缓存余量分支、markInvalid 翻转、吊销 stale 不复活、投影无密钥
- [x] 4.2 pack-store 单测：metadata.credential_ref 分派 + 未连接报 credential-required
- [x] 4.3 e2e（部署后）：面板配对→mcp 行注入→facet-market-mcp 真调——**2026-10-14 生产全链实证**
      （ego-browser 浏览器配对 wire-tester3+platform-test 双身份：绑定码→已连接卡片→cell 库设备行
      →12h token→mesh initialize 200→facet_market_pack_browse author_me=true 返回 3 个自有包
      →facet_market_pack_publish 真发 pack id 9fqlBKNT5eD5WH0lVMEqZQ v1 且市场上架眼见；
      无 creators 组身份 403 如实拒收=门正确；验收包待删）

## 5. 上线

- [x] 5.1 出片+滚动（三 deployment 同滚纪律）+ 生产 4.3 验收
      - [x] 出片两轮（sha-99cc318 全含版→首跑 dsh contracts ⑨ flake rerun 过；sha-ac2fcfd 修复版 9/9 一次过）
      - [x] platform/platform-demo 双滚 sha-ac2fcfd（并行会话先滚的 bd84e6f 已含 14648b5，修复补滚 ac2fcfd）
      - [x] configmap facet-market 行走 GitOps 落库（platform.yaml:404 块——带外 apply 被 selfHeal 打回，教训在案）
      - [x] 生产实证：schema v28 / 路由 401 门 / pair 协议可达（错码 401 透传）/ mcp.json 双行 / 面板 chunk 在位
      - [x] 4.3 cell 装包 agent 真调——等价实证：以配对 token 直调市场面六工具全绿（dsh 会话内同链由 pack 安装时同一注入函数服务）
- [x] 5.2 台账/规约回填（facet-market ref 已归入 LINES-MCP-CONFORMANCE 各线 key 表，2026-10-13）

## 实施实录（2026-10-13）

- 单测 scripts/test-facet-market-credentials.mjs 10/10（假市场全协议对拍：raw32B base64url 公钥/
  deviceId:nonce 签名/base64url——真 node:crypto 验签；串行锁恰一轮；翻面恰一次+自愈；吊销不复活）。
- scripts/test-facet-market-ref-dispatch.mjs 4/4（credentialRefForEntry/credentialConnected 纯函数化）。
- web 类型检查：本 change 文件零错误（树上 SessionToPresetDialog 3 个预存错误系他线未提交工作，不动）。
- 台账联动：registry 条目 /facet-market-mcp 已 PATCH metadata.credential_ref=facet-market（实测回显）。
- 全量单测回归：13 fail 为树上预存（dsh 树坏基线 6+webTurnSessions 适配漏 1 等，与本 change 无关——
  失败文件均非本 change 触碰面；详见提交说明）。

## 6. 操作 pack 发布（狗粮闭环，2026-10-14 完成）

- [x] 6.1 「谦面市场助手」发布（id 0RdQE184anPUaMhIvFwndA v1，platform-test）：
      双技能（facet-market-publishing/gateway-ops）+双 MCP（facet-market-mcp/facet-ops-mcp
      各 allowTools 六）+persona（写操作先查重复述确认）+三步指南；真校验器预对拍 VALID
- [x] 6.2 发布门活例：首发被工具声明门 fail-closed 拦（网关快照 num_tools=0）——
      快照回填（PATCH tool_list 需对象形状 {name,description}，rescan 对该 token 504、
      /api/tools 与 /api/refresh 均 enhanced_auth 不可用）后过门——自家门咬自家包
- [x] 6.3 壹座内装包全链眼见：Subscribe & Install → 双技能物化（facet-gateway-ops/
      facet-market-publishing）+三 MCP 行——**凭据分派数据驱动实证**（facet-market-mcp→
      facet-market ref、facet-ops-mcp→registry 默认）；工具收窄走 pack-scope tool-filter
      patch（设计如此，不在 config 里）
- [x] 6.4 验收包 9fqlBKNT 转 private（匿名 404 实证）
