# Proposal: revise-billing-key-acquisition

## Why

③ 上线后的首次真链路测试（2026-10-02，以真实用户 aloadtree）暴露了计费铸 key 的身份死角：部署者的 sub2api 账户若**早于平台存在**（同邮箱预存账户——网关老用户全都如此），平台不持有其密码，而 sub2api **没有任何 admin 侧代建 key 路由**（上游 Wei-Shaw/sub2api 全 v0.2.x 核对，v0.2.13 于 2026-10-02 发版）→ 部署静默走无 key 降级（实测 `keyRef: null`）。已提交未部署的「派生专属账户」补丁（cf6c311）是带密码托管的绕路，与真实能力不符：**sub2api 面板的 Logto OIDC 登录已在生产启用并全链路验证**（`oidc_oauth_enabled:true` 为唯一第三方登录方式，`/api/v1/auth/oauth/oidc/start` 302→auth.finddatatech.cloud/oidc，discovery 200）——用户本人一键 SSO 即可进入自己的 sub2api 面板建 key。正确的形状是：**key 由用户在自己会话下铸造、经部署请求交给平台；平台零密码托管**。

事实勘误（随本片落档，两处旧论据有误）：
- 「0.2.7 无 admin 改密」系**误判**——上游 `PUT /api/v1/admin/users/:id` 实收 `password` 字段（当年探针只试了 PATCH 与专用路由才全 404）。该能力用于本片存量清理；不改变方向：平台不能重置用户**个人**账户的密码。
- 「admin 代铸会弄坏/绕过面板自身 OIDC 登录」**不成立**——admin 铸 key 路由与面板 OIDC 零耦合；真正的约束是不背自维护 fork。会断 OIDC 的是**全局** `oidc_connect_frontend_redirect_url` 配错；按次 `?redirect=` 已存在但限 same-origin。

## What Changes

- **真实账户解析取代一切代建**：部署时以 admin API 按**邮箱**解析部署者的真实 sub2api 账户（`findUserByEmail`；上游实证 search 匹配 email 列且响应含 email）；无账户 → `402 {code:"NO_SUB2API_ACCOUNT", panelUrl}` 结构化指引（先 Logto 一键登录 token.finddatatech.cloud 建立账户，上游 fast-path 会发注册余额）；余额门照旧（402 加 `code:"INSUFFICIENT_BALANCE"`）。删除 ensureDeployerUser/mintAgentKey 的账户代建与密码托管路径（**取代已提交未部署的 cf6c311 派生账户方案**）。
- **粘贴式 key 交付 + 全量校验**：部署请求体 `billingKeys: { <agentId>: "sk-…" }`（裸串）。服务端四层校验，全部走现成端点、零 sub2api 改动：
  1. 形状：`sk-` 前缀、长度上限；
  2. **活性**：`GET /v1/models`（Bearer 该 key）——模型列表本地构建、零上游调用、走完整计费门，顺带验证余额/组可用；
  3. **归属**：admin `users?search=<key>` 反查持有人（上游实证 search 匹配 key 值子串）→ 与按邮箱解析的 userId 比对，粘别人的 key 当场拒；
  4. agentId 白名单：仅收本 pack 当前 manifest 的 serving agent。
  同一把 key 粘多个 agent → 400（保住「每 agent 一把计量 key」不变量）。校验失败 → `400 {code:"BILLING_KEY_INVALID", reason:"liveness"|"ownership"|"shape"|"duplicate"}`。以平台侧随机引用（`pk_…`）入库，descriptor 带引用、runner 注入与计量链路**不变**（全部已上线）。
- **serving 部署必须绑 key**：无 key 的 serving 部署 → `400 {code:"BILLING_KEY_REQUIRED"}`。与词汇表「部署者=为其消耗付费的账户主体」、ADR-0011 预付准入、spec Purpose 对齐——平台共享配额不再是无门兜底。无 serving agent 的 pack 不受限；存量运行不受影响，重部署时要求补 key。
- **绑定生命周期**：重部署省略 `billingKeys` = **保留**存量绑定（服务端把 `deployment_keys` 续写进新 descriptor；**保留的绑定也重跑活性预检**，死 key 当场暴露，换新 key 即恢复）；显式 `null` = 解绑，仅对非 serving agent 合法（serving agent 的 key 只能**更换**，不能单独拆除）；升级后不再 serving 的 agent，其绑定随重部署清理。
- **部署弹窗 UX（三态发现）**：`GET /api/packs/billing/me` 扩展——无映射行时现查 `findUserByEmail`（命中即落映射行），返回 `{linked, balance, accountState:"none"|"ok"}`；新增 `GET /api/packs/:id/billing-bindings` 只报各 serving agent 有无绑定，永不回显 key 值。检测无在册 key 时显示「连接 sub2api」按钮（**window.open 新标签页**打开面板根路径——面板 `X-Frame-Options: DENY` + `frame-ancestors 'none'` 禁内嵌）+ key 粘贴框；已绑定态显示「已绑定（更换请粘贴新 key）」；余额读出/欠费横幅沿用；五语文案按结构化 code 走 i18n。402/400 指引文案区分两种人：无账户（SSO 即建）vs 预存账户（SSO 撞 choice 屏，输**原面板密码**一次完成绑定）。billing 未联动（无 admin key）时忽略粘贴 key，维持 pre-③ 降级语义。
- **存量清理（ops runbook）**：清点 prod `sub2api_accounts` 密码非空行（③ 期间 pre-cf6c311 代码代建的真邮箱账户）→ 先在生产 fork 实测一次 `PUT /api/v1/admin/users/:id` 带 password 可用 → 改密后将密码**移交用户本人**（或删号让 SSO fast-path 重建、余额先转账），解除其 choice-屏死锁；同时 `UPDATE` 清空存量密码、`sub2api_accounts` 表去密码语义。
- **上线 burn-in**：真实 SSO 全链路走一遍，验证 Logto `email_verified=true`（否则上游落 synthetic email `oidc-…@oidc-connect.invalid`，邮箱解析永远找不到 → 402 死循环）。

## Capabilities

### New Capabilities

（无——本片是对 platform-billing 既有两条要求的修订）

### Modified Capabilities

- `platform-billing`（两条均按仓库重塑规则走 REMOVED+ADDED；req3 runner 取钥、req4 余额门**零改动**）：
  - 「Every deployer maps to one sub2api account」→ **ADDED "Every deployer is resolved to their real sub2api account by email"**：无代建、无密码托管、无账户时的结构化登录指引；
  - 「Deployment mints one metered key per agent」→ **ADDED "Deployment binds a deployer-provided metered key per agent"**：key 来自部署者自有会话（面板/SSO），经请求交付、四层校验、引用、分发——描述符与 runner 侧契约不变。**必须重述**「key 值不上公面」场景；新增「serving 部署必须绑 key」「同 key 不得复用于多 agent」「保留绑定重部署重验」场景。

## Impact

- **Code**: `lib/sub2api-admin.js`（删 ensureDeployerUser/mintAgentKey；增 findUserByEmail、活性预检、search-by-key 归属反查；保留 selfCheck/readUser/adjustBalance）、`gateway/packs.js`（真实账户门 + billingKeys 校验与绑定生命周期 + billing/me 扩展 + billing-bindings 端点；sub2api_accounts 去密码语义）、web 部署详情（三态 + 新标签页连接 + 粘贴框 + 已绑定态，五语）、tests（scripts/test-platform-billing.mjs 改造）。**实现草稿已 stash 在案**（`git stash@{0}: billing paste-flow rework draft`）作为起点——但草稿缺活性/归属校验与 absent=keep 生命周期，须按本片补齐。
- **撤销项**: cf6c311（派生账户）未部署、被本片取代，随实现一并清理。
- **部署面**: 平台镜像一轮滚动；sub2api 侧**零改动零重启**。
- **实测基线（2026-10-02 已验）**: 余额门 402/充值后放行、两级发现、billing board degraded:false、OIDC 全链路活——本片只换 key 来源，其余链路照旧。

## Non-goals

- sub2api 代码/镜像/全局设置任何改动（含全局 `frontend_redirect_url`）。
- 端到端免粘贴自动化：独立后续 proposal——**上游 PR 优先**（admin 代铸路由，或按次跨源 redirect 放行）；**上游 PR 被拒则评估自维护 ~30 行 admin-mint 补丁作为 B 计划**（不因其「影响面板 OIDC」——那不是事实；只因补丁维护成本）。
- key 的过期/轮换提醒（回合期 401/402 自然暴露，运营侧可见后再做提醒面；部署/重部署期的死 key 已被活性预检覆盖）。
