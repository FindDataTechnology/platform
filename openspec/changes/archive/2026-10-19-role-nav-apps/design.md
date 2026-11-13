# role-nav-apps — 设计

## D1 一行配方改动，不碰算法

`packages/core/src/lib/surfaces.ts` 的 `FACTORY_PRESETS.simple.nav` 追加 `"apps"`。
解析链（factory → deployment → role → user）不变：角色层只能在部署层剩余表面内收窄，
部署层若隐藏 `apps`，角色用户照旧看不到——这是既有「终局隐藏」语义，无需新逻辑。

## D2 顺序沿表面注册表

`NAV_SURFACES` 的注册顺序是 chat, knowledge, resources, agents, apps, tasks, fleet。
`simple.nav` 的顺序与之一致（apps 紧随 agents），这样 `simple` 对 `standard-snapshot`
的收窄是严格子序列，用户调整层的重排基线不变。

## D3 为什么只加 apps

- `apps` 是发现面与连接入口（L1b 网格 + 连接徽章 + 去连接），业务用户必须可达。
- `tasks`（任务引擎）与 `fleet`（机群）是技术运维面，仍留在 `standard-snapshot`。

## D4 测试断言同步

六处硬编码列表统一改为五项。`scripts/test-layout-resolution.mjs` 中「管理员免除」用例的
对照断言（非管理员仍收窄到 simple）也随之改——它断言的是「收窄发生」，不是具体四项。
