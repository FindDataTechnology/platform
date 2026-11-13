# add-device-pairing-auth

## Why

壹座将出安卓/iOS 通用客户端（连任意自建实例，见 ADR-0020 与词汇表"通用客户端"）。实例的 AUTH_MODE 有 `none` / `forward_auth` / `logto` 三种，OIDC PKCE 只在 logto 成立且要求每个实例主人改自己的 IdP 配置——唯一对三种全成立的登录路径，是把小程序已验证的绑定码机制泛化为设备配对（信任锚 = 实例自身的 web 会话）。本 change 是 App 计划的第一刀：先行、独立可测，App 侧永远对着真实端点开发。

## What Changes

- 新增 `/api/app/*` 设备配对端点族，网关与单进程两种部署形状共享同一实现（与 miniprogram-auth 同构）：
  - `POST /api/app/pair`：绑定码 + deviceId + Ed25519 公钥 → 绑定并签发平台 JWT
  - `POST /api/app/challenge`：deviceId → 单次短时 nonce
  - `POST /api/app/login`：deviceId + nonce 签名 → 静默换发平台 JWT
  - `GET /api/app/devices` / `DELETE /api/app/bind/:deviceId`：web 会话侧设备列表与撤销
- `mp-bindings` 绑定存储泛化：key 以 `app:<deviceId>` 前缀分 namespace，值携带 Ed25519 公钥与设备自报名；文件格式向后兼容，openid 条目原样保留
- JWT 全复用 `signMpJwt` + `MP_TOKEN_SECRET`，claims 增加 `kind: "app"` 与 `did`；验签用 node:crypto 原生 Ed25519，零新依赖
- web 设置页新增"已配对设备"节（slug `devices`）：铸造绑定码（数字 + QR 两种形态，QR 沿用 `<web-origin>/settings/devices?bindcode=<code>` URL 约定，App 扫码可同时取到实例地址与码）、已配对设备列表（设备名/绑定时间）、单设备撤销
- `GET /api/config` 增加 `capabilities` 通告对象（首键 `devicePairing: true`），供通用客户端能力探测——老实例不回此字段即视为不支持，App 降级不挡路

## Capabilities

### New Capabilities

- `device-pairing-auth`: 设备配对身份路径——绑定码 + Ed25519 公钥的配对交换、单次 nonce 挑战与签名静默换发、401 重新配对语义、web 端已配对设备管理与撤销、`/api/config` 能力通告。双部署形状（网关 per-user cells / 单进程）同一契约。

### Modified Capabilities

- `settings-surface`: Settings 模态的节集合从"恰好九节"变为十节——新增 `devices`（已配对设备）节，排在 `wechat-app` 之后；节 slug、排序、i18n 解析规则不变。

## Impact

- **网关**：`gateway/index.js`（挂载新路由）、`gateway/mp-bindings.js`（存储泛化）、新增 `gateway/app-auth.js`（挑战/验签/端点逻辑，与 `mp-auth.js` 并列共享）
- **单进程**：`server/routes/`（mp.js 的孪生——新 `app.js` 路由或并入现有文件，同一共享模块）
- **web**：设置页新节（组件 + 六语言 i18n 键）、`/api/config` 消费方不受影响（新增字段向后兼容）
- **小程序**：行为零变化，仅回归验证（共享模块改动波及面）
- **不在本 change**：App 客户端本体（第二刀 `add-mobile-app`）、离线推送、多工作区、`MP_TOKEN_SECRET` 轮换
