# fix-ciyuan-oidc-login — 任务清单

> 根因双条：①单值回调只登记 token 域（router 域被 Logto 以 invalid_redirect_uri 拒）；
> ②state cookie host-only（起点≠回调必 invalid_state）。另有 discovery 实时拉取的
> 15s 超时脆弱点（15:28 真实 500 实证）。方案=双宿主各自闭环（白名单派生）+ 填三端点。

## 1. fork 代码（sub2api）

- [x] 1.1 `config.go`：`OIDCConnectConfig` 加 `RedirectURLAliases []string`
      （`mapstructure:"redirect_url_aliases"`），env `OIDC_CONNECT_REDIRECT_URL_ALIASES`
      逗号分隔；默认注册（viper 空默认 + AutomaticEnv 可及，按既有惯例）
- [x] 1.2 `auth_oidc_oauth.go`：回调地址派生函数——请求 Host 命中别名集合的 host 时
      用 `scheme://<请求 Host><redirect_url 的路径>`，否则回落单值；scheme 取
      `X-Forwarded-Proto`（缺省按 `c.Request.TLS` 判断）
- [x] 1.3 单测：命中别名派生 / 未命中回落 / 多别名 / 空别名集合 / 恶意 Host 不派生
- [x] 1.4 缝点台账登记（`docs/sub2api-fork-patches/README.md` §二 新增两处上游文件缝点）

## 2. Logto 侧（保留原回调，补登记）

- [x] 2.1 读现状：Management API 取应用 `jm955c6cnud2yoa6tytno` 的 `redirectUris`
- [x] 2.2 写并集：补 `https://router.finddatatech.cloud/api/v1/auth/oauth/oidc/callback`
      （幂等：已存在则跳过）
- [x] 2.3 复核：直连 Logto authorize 带 router 回调不再返回 `400 invalid_redirect_uri`

## 3. 词元设置（admin API）

- [x] 3.1 填 `oidc_connect_authorize_url=https://auth.finddatatech.cloud/oidc/auth`、
      `oidc_connect_token_url=https://auth.finddatatech.cloud/oidc/token`、
      `oidc_connect_userinfo_url=https://auth.finddatatech.cloud/oidc/me`
- [x] 3.2 复核设置回读 + `needsDiscovery` 转假（登录路径不再拉 discovery——以
      pod 侧对 discovery 的请求计数或日志为证）

## 4. 出片与部署

- [x] 4.1 `fd-build-channel` 判路 → 出片（公开快照线或通用构建池，按判路结论）
- [x] 4.2 GitOps：sub2api deployment 加
      `OIDC_CONNECT_REDIRECT_URL_ALIASES=https://token.finddatatech.cloud/api/v1/auth/oauth/oidc/callback,https://router.finddatatech.cloud/api/v1/auth/oauth/oidc/callback`
- [x] 4.3 滚产（ArgoCD sync + 核 revision，防「sync 假绿」）+ pod 镜像 sha 核验

## 5. 生产验收（双域全链）

- [x] 5.1 router 域 OIDC 全链：登录 → 回 router dashboard（不再 invalid_state）
- [x] 5.2 token 域 OIDC 全链：登录 → 回 token dashboard（回归不变）
- [x] 5.3 两域密码登录回归（不应受影响）
- [x] 5.4 恶意 Host 探针：伪造 Host 头请求 start，确认不派生出未登记回调
- [x] 5.5 台账与发布记录更新（`docs/registry-maintenance.md` §9 或词元台账段）
