# admin-layout-exempt

## Why

2026-10-18 生产实况：admin 账号 `aloadtree@gmail.com` 登录后看不到任何管理配置界面——`/api/auth/me` 报 `isAdmin: true`，但 `resolvedLayout.nav` 只剩 4 项、`settings` 只剩 5 节（models / roles / layout / channels / diagnostics / status / branding 全部消失）。直接原因是测试期（§12.8–§12.14）把 `primary=stock, secondary=[legal]` 留在了该 admin 账号上；根本原因是 role-system 主 spec 明文规定「admin 兼任业务角色时，表现层解析用业务角色」（v1.3.17 有意为之），而业务角色的 `simple` 预设只保留非技术骨架——于是**任何**兼任业务角色的管理员都会丢掉整套管理面。`adminOnly` 谓词只挂在 roles / layout / branding 三节，仅豁免它们救不回 models / channels / diagnostics / status。角色数据已经清掉（界面即刻恢复），本 change 修规格与代码，防止再发。

## What Changes

- **规格变更**：管理员（stored admin 位或 `ADMIN_GROUPS` 组判定为 admin 者）的布局解析 **SHALL 跳过业务角色层**——表现层 = 部署默认（含部署终局隐藏）+ 本人工作台调整。业务角色仍按 role-system 记录与分配（首配方案、pack 作用域、角色分配面不受影响），只是不再决定管理员看到什么。
- `resolveForUser`：`facts.isAdmin === true` 时不构造 role 层（`layers.role = undefined`）。
- 单测 + e2e：admin 兼任 `stock` 时 nav/settings 等于部署默认全集（减部署隐藏）；部署隐藏对 admin 仍终局；非 admin 的 `stock` 仍收窄（既有行为不变）。
- 数据卫生（非代码）：生产 admin 账号的测试角色已于本日清除（`PUT /api/roles/assignments/aloadtree@gmail.com {primary:"standard"}`），角色体验测试改用 roster 内的专用测试账号（`zztrial-*` / `labench-test-view`）。

非目标：adminOnly 谓词语义；角色层对非 admin 的收窄；用户层能力；「管理员预览某角色布局」功能（如需，另立 change，用户层 preset 选择即可覆盖）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `layout-configuration`：「Three-layer resolution with terminal deployment hiding」新增管理员跳过业务角色层的规则与场景
- `role-system`：「Administrator as orthogonal flag」的场景从「表现层用业务角色」改为「表现层不受业务角色收窄」

## Impact

- **后端**：`server/layout.js resolveForUser`（一处条件）；`packages/core/src/lib/surfaces.ts` 不改
- **测试**：`scripts/test-layout-resolution.mjs` 增 admin 用例；`e2e/layout.spec.js` 增「admin 兼任角色仍见全部管理分节」
- **前端**：不改（吃 resolvedLayout）
- **数据**：生产 roles store 已清 admin 账号的测试角色（可逆：重新 PUT 即可）
- **兼容**：非 admin 用户零变化；admin 无业务角色者零变化（本来就不收窄）
