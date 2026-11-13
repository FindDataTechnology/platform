# Design — fix-wire-install-gate-and-credential-delivery

## Context

两条产线事实：① 安装闸分裂——`credential-refs.js` 的 REFS 派发表（`credentialRefForEntry`
经 `pack-store.js:92-95` 转发）已正确把 wire 线服务器派发到 wire-customer ref，但
`credentialConnected` / `credentialMissingReason`（credential-refs.js:128-154）是另一张
手写 if 链，只认 facet-market / chatwoot / paper-trading，其余一律落
`registryCredentials.status`；`KNOWN_CONNECT_PANELS` 却早已映射 wire-customer/lex 面板
（credential-refs.js:171-172）——connectPath 侧预期了线 ref，判活侧没跟上。② 交付
兜底漏网——`dshUpdateMcp`（server.js:739）只在 `authorizationHeadersChanged` 为真时走
交付控制器（`server/dsh-mcp-delivery.js`，f62f2177 为 10-24 13:46 事故而建）；prevAuth
为 null（首装/patch 从无到有）时 credentialChanged 恒 false，落到 server.js:787 的裸
`dshBridge.restart`——dsh-bridge 的 `#restarting` 并发闸（dsh-bridge.js:396）抛
「already in progress」，被 reapplyProfile 的 catch 吞掉，无人重试：与控制器要消灭的
事故形态一模一样，只是换了条路径进来。

另：铸币/粘贴/断开三路由在 store() 后**已经**调 reapplyProfile
（server/routes/line-credentials.js:265/310/323），且 `authorizationHeadersChanged`
（dsh-profile.js:856）对两快照键集**并集**比较——「ref 服务从无到有」本就判为凭据变化。
故「首行不触发交付」的机理不成立于代码；本 change 修确定性（兜底）与可观测性（审计），
并以一步验证裁决身份键别名嫌疑。

## Goals / Non-Goals

**Goals:**

- 无 registry 凭据的真实客户能凭线凭据装 wire/lex pack，拒装时指对连接入口；
- 凭据可变化的一切 patch 交付路径都在交付控制器管辖内（碰撞重试/回合边界/硬顶）；
- 凭据行从无到有可观测（审计事件），下次复发可凭日志裁决机理。

**Non-Goals:**

- 不改交付控制器本体（重试/推迟/硬顶语义已定，单测 scripts/test-dsh-mcp-delivery.mjs 在位）；
- 不修 Logto consent 资产（P2，wire/Logto 侧）；
- 不做 store() 内触发（见 D3）；
- 不预设身份别名结论（D4 验证裁决，坐实则另立后续修复或在 tasks 内追补）。

## Decisions

### D1 安装闸表驱动，而非 8 个 if

REFS 条目可选携带 `connected: (email) => boolean` 与 `missingReason: string`；两个判活
函数改为**先查表、命中即返回；条目未声明这两个字段则走既有 if 链**。

- 备选（否决）：最小两分支补丁——`wanxing-caller`（REFS 已登记，credential-refs.js:89）
  今天就走同一 fall-through，是下一个待踩的同款坑；任何未来新 ref 都会再踩一次。模块头
  注释自述这张表的使命就是消灭分叉，表驱动把这一类 bug 关死。
- 备选（否决）：两函数全量表化（四既有 ref 也搬进表）——对零行为变化的目标引入四个
  无谓风险点；旧链原样保留，由回归场景钉住等价性。
- wire-customer/lex 的 connected 即 `lineCredentials.status(email, line).connected`（语义
  = `liveToken() !== null`，已核实）；missingReason 文案「connect your wire line first —
  no live wire credential」/「…lex…」；connectPath 零改动（面板映射已在）。

### D2 兜底 restart 归交付控制器

server.js:787 的裸 restart 改调 `credentialDelivery.onCredentialChange(patchPath)`。
首装场景 prevAuth=null → 快照不可比 → 恰是「凭据可能变化但 diff 说不准」的情形，交控制器
（空闲立即/忙则回合边界/硬顶）是唯一一致语义。备选（否决）：就地包一层碰撞重试——重造
控制器已有的一半，且丢失忙时推迟语义。

注意语义变化面：旧裸 restart 立即执行（撞则失败）；新路径在 streaming 时推迟。零服务器
首装的 cell 通常无在跑回合，推迟窗与控制器 5min 硬顶一致，验收窗口即 5min。

### D3 首行审计事件，而非 store() 内触发

触发已存在（三路由 reapplyProfile + 并集 diff），再加是空操作。缺的是证据链：`store()`
检测「此前无行」（`db.getLineCredential` 先读一次）时记
`[line-credentials] credential line created: <email> <line>`。日志层即可（与
`[mcp-delivery]` 事件同级），不落库、不含 token。

### D4 身份键别名嫌疑：一步验证，不预设结论

首行事故候选机理之二：写入器 owner（`ctx.runtimeOwnerEmail`，cell 启动种子
`CELL_USER_EMAIL`，server.js:552）与凭据行 ownerKey（`req.ssoUser || req.user`，
line-credentials 路由 identity() 优先 ssoUser）归一化后不一致——wire-tester2/
wiretester2 双 slug 在端点映射里同号并存是既有先例。验证（实施第一步，生产只读）：
出问题的 cell 上 `SELECT email, line FROM user_line_credentials WHERE line='wire-customer'`
与 omit 日志里的 owner 比对。坐实 → 身份归一化修复（ownerKey/normalizeIdentityEmail
收口，或 mint 路由统一用与写入器同源的身份）列入本 change tasks 追补；不坐实 → D2 已
覆盖机理。两个既有修复（D1/D2）在任何裁决结果下都必要。

### D5 验收钉住 consent 交叉面

铸币的 interactive 重试（routes/line-credentials.js:219-221）依赖 Logto consent 对
first-party client 自动授权——与 wire-console consent 坏页同机制。P0 验收序列加一条：
清 Logto 会话的新浏览器完整走一次 wire-customer 铸币。若此处撞 404/白页，则 P2 的波及
面已越出 wire-console，升级证据到手；资产修复仍归 wire/Logto 侧。

## Risks / Trade-offs

- [在途 renewal delta 同库] `add-line-credential-renewal` MODIFY mcp-integration 与
  line-credentials 的两个既有标题，本 change 全 ADDED → 无标题冲突；归档先后均成立，
  语义互补（它管值变化交付，本 change 管兜底路径与判活表）→ 双方 archive 时
  `openspec sync` 按标题合并，无人工合并点。
- [表驱动等价性] 未声明字段的 ref 走旧链是行为等价的关键假设 → 四既有 ref 回归场景
  （spec 已列）+ 既有 pack 安装 e2e 全绿为闸。
- [兜底语义变化] 裸 restart → 可能推迟：首装无在跑依赖，推迟窗有硬顶 → 验收窗口 5min
  与硬顶对齐；e2e 断言「不重启 platform」前置条件不变。
- [身份别名若坐实] D1/D2 之外的第三修复会增加本 change 体量 → 验证放实施第一步，
  结果只影响是否追补 tasks，不动已立 specs。

## Migration Plan

纯服务端发布，无 schema 变更、无配置迁移。上产后 wire 侧配合动作（需求文末备案）：
撤 wire-tester2 的占位 registry 凭据（`DELETE /api/registry/connection`，source=paste，
2026-10-31 到期）——先验证无 registry 凭据装 wire pack 成功，再撤，防止撤早回退客户车道。
回滚：镜像回退即可，无状态残留。

## Open Questions

（无——D4 验证是 tasks 内一步，其结果不改变本设计任何决策的正当性。）
