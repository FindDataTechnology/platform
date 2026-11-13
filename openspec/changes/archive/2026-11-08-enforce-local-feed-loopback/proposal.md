# 本机 roster feed 的令牌缺失档：把「回环开放」落成代码事实

## Why

`local-agent-registry-feed` 的「无令牌请求被拒」场景要求两件事：带错/不带令牌返 401，
且 feed 只绑定 127.0.0.1。代码只做了前者的「令牌已 mint」分支：当
`WANXING_LOCAL_FEED_TOKEN` 为空（dev/headless cell 从未 first-run）时，路由处理函数
直接 `next()`——完全没有地址检查。

这在本机是「开发姿态」，但它把安全边界挂在了 `HOST` 的默认值上（`server.js:122`
默认 `localhost`）。任何把 `HOST` 设成 `0.0.0.0` 的部署（容器常态）就把这条前缀
裸露给整个 pod 网络：`/local-registry/api/agents` 会返回 pack 身份、seat 标、
每 agent 的 runner/拓扑字段，且**零凭据**。auth 门对这一前缀是整体豁免的
（路由自称鉴权），所以地址检查不放在路由里就哪儿都没有。

审计（optimize-paas-module-audit，G8 相邻面）把这条列为「信任边界未登记」的一项；
本次把它从「注释声称」改成「代码执行」，并把 spec 的绝对句（不带令牌一律 401）
校正为如实的两档。

## What Changes

- `server/local-agent-feed.js`：令牌缺失档先判回环地址，非回环一律 401（复用
  `server/auth.js` 新导出的 `isLoopbackAddress`，单一实现）。
- `openspec/specs/local-agent-registry-feed/spec.md`：R1 正文与「无令牌请求被拒」
  场景改写为两档（已 mint 必带令牌；未 mint 仅回环），并要求缺档时日志点名。
- `scripts/test-local-feed-auth.mjs`：5 条穿真路由的护栏（三种回环地址形态放行、
  三种非回环地址 401、令牌档 三态、令牌档下非回环带对令牌放行）。

非目标：不改令牌 mint 流程，不改 feed 的读面形状，不引入新凭据类型。

## Impact

- 影响面：桌面/容器 dev cell 的本机 runner 轮询（仍走回环，不受影响）；
  唯一行为变化是「HOST 非回环 + 无令牌」的部署从此 401，而不是静默开放。
- 无迁移、无数据变更。
