# Proposal: role-system

## Why

布局预设与首配方案（后续 `layout-configuration`、`intent-onboarding` 两案）都以业务角色为枢轴（ADR-0028），但平台今天只有 admin/非admin 二值（`server/auth.js` 的 `ADMIN_GROUPS`→`ctx.requireAdmin`）加 Logto 组做市场准入——"法律人员/技术用户"这类按业务分工的用户类型无处安放，"这版为非技术用户优化、技术用户后置专门模块"的分界也没有承载物。角色体系是两个后续案的共同前置，必须先立。

## What Changes

- **平台自有业务角色表**（ADR-0028）：部署级存储、admin 可分配、env 兜底种子，托管与本地行为一致。枚举按业务分工：`legal`（法律人员）、`economic`（经济分析）、`financial`（金融分析）、`stock`（股票分析）、`screenplay`（剧本创作）、`paper`（论文写作）、`technical`（技术用户），`standard`（标准用户）为兜底默认。
- **主角色制**：每个用户恰一枚主角色 + 任意多副角色。主角色是布局预设与默认专家的解析键（消费方在后续两案，本 change 落数据结构与分配面）。
- **管理员收编为正交授权标志**：用户档案上独立的 admin 位，可叠加于任何业务角色；现有 `ADMIN_GROUPS` 组语义与全部 `requireAdmin` API 门**原样保留**为来源之一（组命中即视为持标志）。
- **准入组映射**：每枚角色可声明映射的准入组名；服务端把角色映射与用户实际组取交集决定市场可见性。Logto 侧零改动。
- **管辖边界（v1）**：角色只管表现层（布局预设选择、前端显隐）；API 鉴权沿用现状，不做全面 RBAC。预设数据以角色为全限定词，将来升级 RBAC 不改数据。
- **分配面**：设置→管理组新增"用户角色"分节（admin 可见），列出用户、改派主/副角色、授予/收回管理员标志。问卷自助授予主角色留给 `intent-onboarding`，本 change 提供 REST 与 admin 面。

## Capabilities

### New Capabilities

- `role-system`: 业务角色的枚举、存储、分配（admin 面 + REST）、主角色制、正交管理员标志、准入组映射与交集语义、本地退化（auth 关）与 env 兜底种子。

### Modified Capabilities

- `settings-surface`: 管理组新增 `roles`（用户角色）分节——分节清单、slug、adminOnly 门。

## Impact

- **服务端**：新增角色存储与 REST（`GET/PUT /api/roles`、`GET/PUT /api/roles/assignments/:userId` 形态，design 决断）；`server/auth.js` 的用户对象扩展 `roles`/`isAdmin` 解析；市场可见性过滤处叠加角色映射交集。部署级存储的落点（gateway 侧 vs 部署共享库）在 design.md 决断。
- **前端**：`web/src/components/settings/sections.ts` 注册 `roles` 分节 + 新分节组件；`useAppConfig`/会话对象携带当前用户角色。
- **兼容**：无角色数据时人人解析为 `standard`，行为与今天一致；`ADMIN_GROUPS` 不变；存量 e2e 不受影响（新增分节不改变既有分节清单的可观测行为——settings-surface delta 同步扩清单 requirement）。
- **词条与 ADR**：CONTEXT.md 业务角色词条、ADR-0028 已落，本 change 是其首个实现载体。
