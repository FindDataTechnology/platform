# fix-ciyuan-oidc-login — design

## Context

词元（sub2api 谱系 fork）现由两个公开宿主对外：`token.finddatatech.cloud`（原域，
壹座产品中心 `agents.json` 与桌面端 `dsh-profile.js` 的网关基址）与
`router.finddatatech.cloud`（2026-10-01 起的新域，官网 `finddatarouter.md` 与发布说明
主推）。二者由同一 deployment 服务（Caddy 两个 server 块 → 同一 NodePort 32080），
应用层无 Host 区分逻辑。

OIDC 侧：Logto（`auth.finddatatech.cloud`，应用 `jm955c6cnud2yoa6tytno`，type
Traditional）现只登记一条回调（token 域）。词元设置 `oidc_connect_redirect_url` 同为
token 域单值；`authorize_url`/`token_url`/`userinfo_url` 三项为空，登录时实时拉
discovery（15s 超时，无缓存）。

实测证据（2026-10-15）：
- token 域 OIDC 全链成功（测试账号回到 dashboard）。
- router 域 OIDC 全链失败，终态 `token.finddatatech.cloud/auth/oidc/callback#error=invalid_state`。
- 直连 Logto authorize 带 router 回调 → `400 oidc.invalid_redirect_uri`。
- 生产日志 15:28:37 一次真实 500：discovery 拉取 `context deadline exceeded`（15014ms）。

## Goals / Non-Goals

**Goals:**
- 两个公开宿主各自能在本宿主完成 OIDC 登录（同一账号体系、同一 Logto 应用）。
- 登录路径不再依赖运行时 discovery 拉取（消除 15 秒超时 500 的触发面）。
- 保持既有单值 `redirect_url` 语义为回落路径——不改变未配置别名时的行为。

**Non-Goals:**
- 不砍任何域名（10-01 发布说明的 30 天过渡期未到；桌面端与壹座仍指 token 域）。
- 不改 Logto 的登录/注册策略、不改账号模型、不动车道与计费面。
- 不引入通配符或按 Host 任意派生（安全取向：白名单别名，防 Host 头伪造）。

## Decisions

### D1 双宿主闭环：回调地址按请求主机派生（白名单）

- 新增配置 `oidc_connect.redirect_url_aliases`（env
  `OIDC_CONNECT_REDIRECT_URL_ALIASES`，逗号分隔的完整回调 URI 列表）。
- 派生规则：请求 Host 命中别名集合时，redirect_uri =
  `scheme://<请求 Host><既有 redirect_url 的路径>`；未命中则用既有单值 `redirect_url`。
- **白名单而非任意派生**：Host 头可伪造；若按任意 Host 派生，攻击者可让授权码落到
  自己控制的主机。白名单把可派生宿主钉死为登记过的完整 URI，未命中不派生。
- scheme 取 `X-Forwarded-Proto`（边缘 Caddy 已设），缺省按请求 TLS 判断。
- 备选否决：①「直接把 redirect_url 改指 router」——反手弄坏 token 域（壹座产品中心
  与桌面端在用）；②「两域各自一套 Logto 应用」——身份面分裂，账号要重绑，且违背
  单一身份（ADR 语境：全线统一 OIDC）；③「按 Host 任意派生」——见上，安全不可接受。

### D2 Logto 侧补登记（保留原回调）

该应用 `redirectUris` 变为两条（token 域 + router 域）。管理经 Logto Management API
（M2M 凭据已可用，resource `https://default.logto.app/api`）；也可经管理台
`auth-admin.finddatatech.cloud` 人工操作——本 change 走 API（可复现、可审计）。

### D3 填三个 endpoint，去 discovery 依赖

`authorize_url` / `token_url` / `userinfo_url` 取现网 discovery 文档真值：
`https://auth.finddatatech.cloud/oidc/auth`、`/oidc/token`、`/oidc/me`。
写入后 `needsDiscovery` 为假（三者非空且 JWKS 已配），登录路径不再发起 discovery
请求。JWKS 已是显式值，保持不变。

### D4 缝点登记（谱系纪律）

回调派生落在 `auth_oidc_oauth.go`（上游文件），属新缝点；配置字段落在
`config.go`（同上）。两处按 ADR-0024「只增不改」登记进
`docs/sub2api-fork-patches/README.md` 缝点台账，月度窗仅在此二文件解冲突。

### D5 出片与部署

fork 代码变更 → 出片（`fd-build-channel` 判路；org 私有额度已尽，走公开快照线或
通用构建池）→ GitOps 加 env → ArgoCD 滚 → 探针。

## Risks / Trade-offs

- **Host 头伪造**：白名单缓解（未命中回落单值，不派生）。派生值只从**登记过的**
  URI 取路径，Host 段虽来自请求但必须在白名单内。
- **两宿主会话独立**：用户在 token 域登录后访问 router 域仍需再登一次（token 存
  localStorage，跨域不共享）。这是既有事实（两域一直如此），本 change 不改变；
  若要跨域 SSO 需另立 change（涉及 cookie Domain 与前端存储策略）。
- **discovery 值硬编码漂移**：Logto 端点若迁移，三个显式 URL 需同步更新——权衡后
  接受（消除超时面优先），漂移由「登录失败」这一强信号暴露。
- **缝点新增**：月度窗冲突面 +1 文件；已在台账登记，属可预期成本。

## Migration Plan

1. fork 代码改动 + 本地轻测（Node/Go 轻测）→ CI 重测（Go 测试按家法只推 GHA）。
2. Logto 补登记 router 回调（幂等：先读现状再写并集）。
3. 词元设置写入三项 endpoint + 别名集合（经 admin API，部分 PUT 语义安全——已核
   `omittedSettingKeys` 机制）。
4. 出片 → GitOps env（`OIDC_CONNECT_REDIRECT_URL_ALIASES`）→ 滚产。
5. 双域全链实测（OIDC + 密码两条路）。
6. 台账登记缝点与出片事实。

**回滚**：别名 env 移除即回落单值行为（router 域回到修复前状态，token 域不受影响）；
Logto 回调可保留（多余登记无害）。设置三项 endpoint 保留亦无害。

## Open Questions

（无——待实施中确认：派生时 `X-Forwarded-Proto` 在 NodePort 直连场景缺失的回落行为，
以现网 Caddy 配置为准，实施时实测覆盖。）
