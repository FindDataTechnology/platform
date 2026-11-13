# Design — admin-layout-exempt

## Context

动机见 proposal.md。实现相关事实：`server/layout.js resolveForUser({ roles, facts, ... })` 已接收 `facts.isAdmin`（现仅供 `adminOnly` 谓词过滤），role 层由 `roles.primary` 查部署 role→preset 映射或配方默认得到 `rolePreset` 后塞进 `layers.role`。`packages/core/src/lib/surfaces.ts` 的 `resolveLayout(layers, facts)` 对缺失的 role 层已是「无收窄」语义（配方缺失的角色本就走这条路）。

## Goals / Non-Goals

**Goals:** 管理员永远看得到整套控制台；一处条件、零前端改动；非 admin 行为逐字节不变。
**Non-Goals:** 改 adminOnly 语义；给管理员「预览某角色布局」的入口。

## Decisions

### D1 跳过 role 层，而非把 adminOnly 分节并回来

`facts.isAdmin === true` → 不计算 `rolePreset`、`layers.role` 留空。备选「保留角色收窄 + 把 adminOnly 分节 union 回来」被否：adminOnly 只标了 roles/layout/branding，models/channels/diagnostics/status 都没标（它们各自在组件内门控），union 救不回用户要的管理界面；再给这些分节补 adminOnly 又会改变非 admin 的可见性语义，面更大。管理员 = 运维者，整套控制台就是其工作台；想窄可用用户层调整。

### D2 角色数据照旧记录

不动 roles store 与 `/api/auth/me` 的 roles 投影——首配配方、pack 作用域、角色分配面继续按角色工作；只有 layout 这一个消费方对 admin 视而不见。spec 场景明写「recorded primary role is still legal for every non-layout consumer」。

### D3 测试角色不再落在真实 admin 账号上（纪律，非代码）

L1/L1b 的真机脚本都把角色账号当测试夹具用。本 change 后 admin 账号带角色不再能复现角色收窄，角色体验测试改用 roster 内专用账号；`verify-live-connections.mjs` 的「临时清角色→恢复」段落在 admin 账号上将变成 no-op（不影响其余断言）。

## Risks / Trade-offs

- [管理员误以为自己也能体验角色用户看到的收窄] → 用户层 workbench 可自行隐藏；如需真预览另立 change。
- [`facts.isAdmin` 在 auth off 时的值] → 现有谓词逻辑以 `authOn===true && isAdmin!==true` 才过滤，auth off 等于机器所有者=admin，本 change 同样视为 admin 跳过 role 层——与「auth off 全开」一致。

## Migration Plan

纯代码；常规出片；回滚即恢复旧解析（admin 兼任角色会再次收窄）。生产验收：给 admin 账号临时 PUT 一个 `stock` 角色 → 读 `/api/config` 断言 nav/settings 等于部署默认 → 恢复 `standard`。
