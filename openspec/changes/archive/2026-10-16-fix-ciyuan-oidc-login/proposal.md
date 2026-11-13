## Why

萬星·词元（FindDataRouter）的 OIDC 登录在 `router.finddatatech.cloud`（官网与发布说明
主推的新域）上**必然失败**，实测终态为
`token.finddatatech.cloud/auth/oidc/callback#error=invalid_state`。从 `token.` 域登录则
正常——即同一产品两个公开宿主，一个能登录一个不能。

根因是两条缺陷咬合：

1. **单值回调 + 单条登记**：词元设置 `oidc_connect_redirect_url` 只写 token 域；Logto
   应用（client `jm955c6cnud2yoa6tytno`）也只登记了 token 回调。router 域发起的
   authorize 请求被 Logto 以 `oidc.invalid_redirect_uri` 拒绝（实测 400）。
2. **cookie 主机绑定**：sub2api 的 state/nonce/PKCE cookie 不设 Domain（host-only），
   「起点主机 ≠ 回调主机」时 state 校验必然失败——即便 Logto 放行也过不去。

另有一个独立脆弱点：`oidc_connect_authorize_url` / `token_url` / `userinfo_url` 三项为空，
每次点登录都要**实时拉取 discovery 文档**（15 秒超时、无缓存）。2026-10-15 15:28 生产
日志有一次真实用户因此拿到 500（`context deadline exceeded`，latency 15014ms），30 秒后
该访客改用邮箱注册。pod 内 `auth.finddatatech.cloud` 经 CoreDNS 钉到 tailnet 边缘
（`100.64.0.1`），这条路存在间歇超时风险。

两个域都是对外在用的（壹座产品中心与桌面端指向 `token.`，官网与发布说明指向 `router.`），
且 10-01 发布说明已把 token 列为「并行应答 30 天后转永久重定向」的过渡域——因此本
change 不提前砍域名，而是让**两个宿主都能在本宿主完成登录**。

## What Changes

- **fork 侧（sub2api，一处新缝点）**：OIDC 回调地址按请求主机派生——当请求 Host 命中
  登记的别名回调集合时，用 `scheme://<请求 Host><回调路径>`；否则回落既有单值
  `redirect_url`。别名集合经新增配置 `oidc_connect.redirect_url_aliases`
  （env `OIDC_CONNECT_REDIRECT_URL_ALIASES`，逗号分隔完整 URI）供给，白名单制
  （未命中不派生，防 Host 头伪造外泄）。
- **Logto 侧**：该应用 `redirectUris` 补登记 router 回调（保留 token 回调），双宿主
  各自闭环。
- **词元设置侧**：填 `authorize_url` / `token_url` / `userinfo_url`（值取自现网 discovery
  文档），登录路径不再实时拉 discovery，15 秒超时 500 的触发面消失。
- **部署侧**：sub2api deployment 加 `OIDC_CONNECT_REDIRECT_URL_ALIASES` 环境变量
  （GitOps），滚一版镜像（fork 代码变更）。
- **台账**：缝点台账登记新缝点（回调派生），出片与探针结论按谱系纪律登记。

## Capabilities

### New Capabilities

- `ciyuan-gateway-identity`: 词元网关的身份入口面——公开宿主上的登录必须在本宿主完成
  （多宿主 OIDC 闭环）、登录路径不依赖运行时 discovery 拉取。

### Modified Capabilities

（无）

## Impact

- 代码：fork 仓 `FindDataTechnology/sub2api`——`backend/internal/config/config.go`
  （新配置字段+默认注册）、`backend/internal/handler/auth_oidc_oauth.go`（回调派生，
  新缝点）；上游文件仅此两处，其余零改动。
- 配置：Logto 应用 `redirectUris`（Management API）；词元 DB 设置三项 endpoint；
  fd-infra-deploy sub2api deployment env。
- 出片：GHA → hkccr → cheap-3 relay → ccr（`fd-build-channel` 判路；org 私有额度已尽，
  走公开快照/构建池线）。
- 无对外契约变化：既有两个域的登录行为从「一个坏」变为「都可用」；API/车道不受影响。
