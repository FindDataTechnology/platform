# Design: role-system

## D1 — 双层存储与解析链（核心决策）

角色指派是部署级数据，但进程拓扑是 per-user cell（各带独立 SQLite）。branding 的 `deployment_config` 表只在本地/单 cell 语义下是"部署级"；托管多 cell 下 admin 的改派必须跨 cell 生效。**定案双层**：

- **本地（单进程/桌面/auth off）**：存 cell 的 `deployment_config` 键值表（新增键，JSON 序列化，零 migration，与 branding 同款）。
- **托管（gateway 前置）**：gateway 侧自有小存储（JSON 文件，路径可配），经**既有签名身份头通道**下发——`forwardedHeaders()`（`gateway/proxy.js`）已带 `CELL_GATEWAY_SECRET` 校验的身份头，扩展两个头：主/副角色 slug 列表与 admin 标志。cell 只信带签名的头。
- **cell 内解析序**（单一代码路径）：网关签名头（存在即用）→ 本地 `deployment_config` → env 种子 → `standard` 兜底。stored > env > 兜底，与 branding 的解析序同构。

## D2 — REST 面

- `GET /api/roles`：枚举（slug+本地化键），任何已登录用户可读，不含他人指派。
- `GET /api/roles/assignments`：admin；列出用户指派（主/副/admin 标志）。
- `PUT /api/roles/assignments/:userId`：admin；整体替换该用户指派（primary 单值、secondary 数组、admin 布尔）；校验 slug 合法、primary 不得为空。
- 托管下三个路由挂在 gateway 的 cell-proxy 之前（gateway 直答、读写自己的存储）；本地由 cell 直答。**URL 空间两边一致**，前端不感知拓扑。
- 非 admin 写 → `403`，语义与 `ctx.requireAdmin` 现状完全一致（auth off 时开放——机器 owner）。

## D3 — 管理员合成

`isAdmin(user) = storedAdminFlag(user) ∨ (authOn ∧ user.groups ∩ ADMIN_GROUPS ≠ ∅)`。`ADMIN_GROUPS` 路径原样保留（ADR-0028 的兼容承诺）；auth off 恒 true（现状）。业务角色枚举不含管理员。

## D4 — 准入语义（精确化）

身份组权威、角色映射兜底：**用户身份携带组时，组即有效准入集，角色映射不增不减；身份无组时（本地/未同步的托管用户），用户各角色映射组的并集即有效准入集**。这兑现共识"托管复用已验证门控、本地角色即全部真相"，也避免角色表旁路客户的 IdP 准入管控。

## D5 — 前端

- `web/src/components/settings/sections.ts` 注册 `roles` 分节（Management 组、`adminOnly: true`），新 `RolesSection` 组件：用户列表 + 主角色下拉 + 副角色多选 + admin 开关，走 D2 REST。
- 当前用户自身角色随 `GET /api/config` 下发（`roles: { primary, secondary }`），`useAppConfig` 扩展读取——后续 `layout-configuration` 在此消费，不在本 change 预建消费逻辑。
- 五语言 locale（zh-CN 先行）+ `npm run check:locales` 门。

## D6 — 兼容与测试

- 无指派数据 → 人人 `standard`，全部可观测行为与基线一致（存量 e2e 零改动为验收线）。
- 新增 e2e：admin 改派生效（下次会话加载）、非 admin 写 403、`/settings/roles` 对非 admin 隐藏、本地 env 种子解析序。

## 风险与边界

- gateway 存储无锁并发：单 admin 操作面，JSON 文件原子写（tmp+rename）足够；不引入 SQLite。
- 角色头注入扩大签名头面：沿用既有 secret 校验，不新增信任面。
- `intent-onboarding` 的问卷自助授予将复用 D2 的 PUT（以当前 userId 为目标），本 change 不实现问卷入口。
