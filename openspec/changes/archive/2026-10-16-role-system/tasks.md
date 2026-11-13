# Tasks: role-system

## 1. 服务端角色内核

- [x] 1.1 角色枚举常量与校验（slug 清单、标签 i18n 键、准入组映射表；`legal`→`legal`、`economic`/`financial`/`stock`→`analysts` 起步值可 env 覆盖）
- [x] 1.2 本地指派存储：`deployment_config` 新键（主/副角色 + admin 标志，JSON），读写函数 + env 种子（`ROLES_DEFAULT_PRIMARY` 等）解析序 stored→env→`standard`
- [x] 1.3 网关签名头消费：cell 侧从既有 `CELL_GATEWAY_SECRET` 校验头读角色/admin（存在即优先于本地存储），挂进 `server/auth.js` 用户对象（`user.roles`、`user.roleAdmin`）
- [x] 1.4 `isAdmin` 合成：storedAdminFlag ∨ ADMIN_GROUPS 命中（auth on）；auth off 恒 true；现有 `ctx.requireAdmin` 语义不变
- [x] 1.5 准入语义：市场可见性过滤接入"身份组权威、无组时角色映射并集"规则（`server.js` 的 registry/pack 可见性过滤处）

## 2. REST 与网关路由

- [x] 2.1 cell 路由：`GET /api/roles`（登录可读）、`GET /api/roles/assignments`、`PUT /api/roles/assignments/:userId`（后两者 `requireAdmin`；PUT 校验 slug/非空 primary，非法 4xx 不落库）
- [x] 2.2 gateway：角色指派 JSON 存储（原子写）+ `forwardedHeaders` 扩展角色/admin 头 + `/api/roles*` 三路由挂 cell-proxy 之前直答
- [x] 2.3 `GET /api/config` 增当前用户 `roles: { primary, secondary[] }`（无鉴权面扩张，随既有 config 下发）

## 3. 前端

- [x] 3.1 `useAppConfig` 扩展 `roles` 字段（类型+读取，暂无消费方）
- [x] 3.2 `sections.ts` 注册 `roles` 分节（Management 组、`adminOnly`、slug 进 `SETTINGS_SECTIONS`；`/settings/roles` 深链）
- [x] 3.3 `RolesSection` 组件：用户列表 + 主角色下拉 + 副角色多选 + admin 开关，PUT 整体替换，错误内联展示（沿用 BrandingSection 的分节内错误约定）
- [x] 3.4 五语言 locale（zh-CN 先行）：分节名、角色标签 `roles.slug.*`、操作文案；`npm run check:locales` 绿

## 4. 测试与验收

- [x] 4.1 e2e：admin 经 `/settings/roles` 改派主角色→目标用户下次会话加载生效
- [x] 4.2 e2e：非 admin 打开设置不见用户角色分节、直访 `/settings/roles` 回落 General、PUT 得 403
- [x] 4.3 e2e：无指派基线——全新数据目录启动，导航与设置与主分支快照一致（存量 e2e 零改动全绿）
- [x] 4.4 本地 env 种子解析序单测（stored 胜 env 胜兜底）
- [x] 4.5 `openspec validate role-system --strict` 绿
