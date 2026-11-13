# role-nav-apps — 角色预设 `simple` 的主导航加入「应用」

## Why

业务角色配方（legal / stock / economic）全部解析到 `simple` 预设，而 `simple` 的主导航
只有 Chat / Knowledge / Resources / Agents 四项——**首配角色用户到不了应用中心**
（`nav-apps` 不可见，只能直开 `/apps`）。§12.15 真机走查（2026-10-18，`aloadtree@gmail.com`
以 `stock` 角色）把这条记作「观察，待拍板」。

应用中心此时已成为发现面与连接入口：L1b 统一网格的每张卡带连接徽章和「去连接」，
L2a 词元账号线的用户入口正是词元卡的「去连接」，L2b 语音亦依赖词元账号绑定。
角色用户被挡在这个入口之外，等于前面三刀对他们不可达。

用户 2026-10-18 拍板：**stock 这类角色主导航也要加应用项**。

## What Changes

- `FACTORY_PRESETS.simple.nav` 由 `["chat","knowledge","resources","agents"]` 改为
  `["chat","knowledge","resources","agents","apps"]`（顺序沿表面注册表：apps 在 agents 之后）。
- `tasks` / `fleet` 仍不进 `simple`（任务引擎与机群是技术面）。
- 同步所有硬编码该列表的断言：`scripts/test-layout-resolution.mjs`（4 处，含管理员免除用例的
  「非管理员仍收窄」对照）、`scripts/test-layout-storage.mjs`（1 处）、`e2e/layout.spec.js`（1 处）。
- 主 spec `layout-configuration`「Versioned layout preset schema」要求与场景同步改写。

## Non-goals

- 不改 `standard-snapshot`；不改 `simple` 的 settings / agentsTabs。
- 不新增预设、不改解析算法（三层/管理员免除均不动）。

## Impact

- 配方 `legal` / `stock` / `economic` 的用户登录后侧栏多一项「应用」。
- 部署层若已隐藏 `apps`，终局隐藏仍生效（角色层不能揭示部署层隐藏的表面）。
