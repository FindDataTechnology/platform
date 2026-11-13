# 部署期铸造必须发生在「持有部署者连接器账号」的进程里

## Why

`add-deployment-binding-grant` 把绑定铸造放在部署路径上，前提是那个进程能读到部署者的连接器账号
（`connectorCredentials.liveToken(email)`）与连接器入口（`connectorOrigin()`）。**这个前提在
gateway + facet 拆分拓扑（正是 fd-prod）下不成立**：`FACET_BASE_URL` 一设，`/api/packs` 整个前缀
被代理到 facet，deploy 路由在 **facet 容器**内执行；而 facet 既没有 operator 的 `mcp.json`，
也没有任何 cell 库（`/data/data` 在 facet 里根本不存在，它的数据根是 `/data/facet`），
于是 `liveToken` 恒为 null。

2026-11-08 真机两步实证（同一部署，两次）：
1. 修补前：`[packs] deployment binding prune for <pack>: connector_not_configured` —— 连入口都没有；
2. 把 `platform-mcp-config` 挂进 facet 后：同一行变成 `no_account` —— 入口有了，凭据没有。

两次 `deployment_secrets` 都是零行。也就是说：在这个拓扑下，**带绑定的包部署出来是"看起来成功、
实际接不到外部系统"**——正是本能力立项时要消灭的那种失败，只不过这次发生在平台自己的进程边界上。

## What Changes

- 明确执行位置契约：铸造 SHALL 在能读到部署者连接器账号的进程内完成。跨进程时由持有凭据的一侧代为铸造，
  另一侧只做存储与下发；不得以"静默 no_account"让绑定消失。
- 部署面在无法铸造时如实呈现（已由 `surface-deployment-bindings` 落到 UI），本变更补上「为什么会失败」
  的可诊断性：`no_account` 在拆分拓扑下应指向"进程无凭据"而不是"用户没连账号"。

## Impact

- 受影响能力：`connector-bindings`（新增一条执行位置要求）
- 代码面（待实现）：`gateway/packs.js` 的部署铸造段、新增内部代铸通道、`deployment-bindings.js`
- 已在产的第一步修补保留：`fd-infra-deploy` 把 `platform-mcp-config` 挂进 facet（commit d6179b315）——
  它是必要条件，不是充分条件
