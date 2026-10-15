# ciyuan-gateway-identity Specification

## Purpose

萬星·词元（FindDataRouter）多宿主部署下的登录身份闭环：OIDC 授权启动与回调
在 token/router 两域均可完成（别名白名单派生回调），且不存在由请求 Host 派生的
任意回调地址。

## Requirements

### Requirement: 多宿主登录闭环（别名白名单派生）

词元网关 SHALL 支持在多个登记过的公开宿主上各自完成 OIDC 登录：当登录发起请求的
Host 命中登记的别名回调集合时，OIDC 回调地址 SHALL 按该请求主机派生
（`scheme://<请求 Host><既有回调路径>`）；未命中时 SHALL 回落既有单值回调配置。
派生 SHALL 仅限白名单——未登记的 Host SHALL NOT 影响回调地址（防 Host 头伪造导致
授权码外泄）。宿主间会话 SHALL 保持独立（登录态不跨域共享）。

#### Scenario: 新宿主完成登录闭环

- **WHEN** 用户在 `router.finddatatech.cloud` 发起 OIDC 登录并在 Logto 完成认证
- **THEN** 回调落在 router 域并由该域完成 state 校验，最终进入 router 域控制台
  （不再出现 `invalid_state`）

#### Scenario: 原宿主登录不回归

- **WHEN** 用户在 `token.finddatatech.cloud` 发起 OIDC 登录
- **THEN** 行为与修复前一致（回调落 token 域并成功进入控制台）

#### Scenario: 未登记 Host 不派生

- **WHEN** 请求带未登记（或伪造）的 Host 头访问登录发起端点
- **THEN** 回调地址回落到既有单值配置，不按该 Host 派生

#### Scenario: 别名集合未配置时行为不变

- **WHEN** 部署未配置别名集合
- **THEN** 回调地址恒为既有单值配置（等价于本 change 之前的行为）

### Requirement: 登录路径不依赖运行时 discovery

词元网关 SHALL 在授权、令牌与用户信息端点均已显式配置时，直接使用这些端点完成
登录流程，SHALL NOT 在每次登录发起时实时拉取 discovery 文档。缺省配置
（端点为空）时的 discovery 回落行为 SHALL 保留。

#### Scenario: 显式端点配置下无 discovery 拉取

- **WHEN** 授权/令牌/用户信息三端点均已配置，用户发起 OIDC 登录
- **THEN** 登录流程不发起 discovery 文档请求（以 pod 侧请求日志为证）

#### Scenario: 端点缺失仍可回落

- **WHEN** 任一必需端点为空的部署发起登录
- **THEN** 系统仍按既有行为经 discovery 解析端点（兼容性保留）
