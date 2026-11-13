# runtime bindings：补回「显式重试应用」这条活接口（N-14）

## Why

`user-runtime-bindings` 50 天未回访。逐条对代码核，五条 Requirement 的骨架都成立
（三枚 REST 端点、WS 三事件、cell 作用域、共享运行时边界），但少了一条**活接口**：

`POST /api/users/me/bindings/apply`（`server/routes/user-bindings.js:80`）在架、
在 SDK 里导出（`packages/core/src/api/bindings-api.ts:39` `applyBindings`），但
现行 spec 里没有一个字。它在旧 spec 里有过出处——`add-sso-user-runtime-bindings`
的「暂存档案被显式重提」场景（归档 spec 第 106 行），那套 coordinator 口径被
`add-multi-tenant-cloud` 的 cell 化改写替换掉时，场景随 requirement 一起消失，
**端点却留下来了**。

后果不是「文档少一句」，而是：一个身份面写接口没有契约背书、没有测试钉它、
语义只存在于实现里（busy → `{ok:false,pending:true}` 并排队；idle → 应用并广播
`runtime_binding`）。下一个人要么以为它可删，要么照实现猜语义。

`tenant-cell-runtime`（35 天）同批核过：AGENT_WORKSPACE 钉
（`gateway/spawner.js:337` + `server/agent-session.js:73` 拒收留痕）、本地盘
SQLite、市场/服务面在部署级——全部成立，不动。

## What Changes

- `user-runtime-bindings`「Runtime bindings are cell-scoped state」补充：在 cell 化
  之后**保留**一枚显式重提端点，说明它为什么还在（重试一次被 busy 挡下的应用，
  或把运行时拉回持久化档案），以及它的返回值三态。既有两条场景原样保留，新增
  一条端点场景。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `user-runtime-bindings`：一条 Requirement 补端点契约 + 一条场景。

## Impact

- 纯 spec 文本；零代码改动。核过但未改：`tenant-cell-runtime` 全部五条
  Requirement（逐条对上 `gateway/spawner.js`、`server/agent-session.js`、
  `server/library-fetch.js`）。
