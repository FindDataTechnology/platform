## Context

现状三处叠加成白屏事故面（见 proposal.md - Why）：`gateway/index.js` 以 `express.static(WEB_DIST)` + `res.sendFile(index.html)` 提供壳，均无 `Cache-Control`；单进程 `server.js` 同形态服务 SPA（`web-chat-server` 能力的深链回退）；`web/src/App.tsx` 全部路由 `lazy()` + `Suspense`，全仓无 ErrorBoundary。Vite 构建产物文件名带内容哈希（`dist/assets/*.hash.js`）。

## Goals / Non-Goals

**Goals:**
- 滚版后任何客户端导航不再命中「旧壳 + 已删 chunk」组合；命中时自愈。
- 任何渲染期异常降级为内容区错误卡，壳与导航保持在场。
- 不引入新前端依赖（沿本仓零依赖叶模块纪律）。

**Non-Goals:**
- 不做 Service Worker / PWA 离线壳（过度工程）。
- 不改 Vite 分包策略（chunk 粒度维持现状）。
- 不追数据相关的渲染崩溃本身（智语偶发白屏按壳竞态处置；若硬刷新后仍复现，另立缺陷单）。

## Decisions

**D1 缓存头挂在应用层两处，不依赖边缘。** `express.static` 用 `setHeaders` 回调：`assets/` 且文件名含哈希 → `public, max-age=31536000, immutable`；其余 → 短 `no-cache`。SPA 回退路由的 `sendFile` 传 `{ headers: { 'Cache-Control': 'no-cache' } }`。gateway 与 server.js 抽同一小函数（零依赖叶模块 `lib/spa-static-headers.js`），防两处分叉。备选：只在雷池/nginx 层加头——被否，桌面客户端走本地 gateway，边缘层不在链上。

**D2 ErrorBoundary 双层：布局内层保壳，根部外层兜底。** 内层包 `<Suspense>`+`<Routes>` 的内容子树（侧边栏在外，崩溃不掉导航），错误卡走 `states-kit` 词汇并提供「重试」（重置边界 state 重渲染子树）与「重新加载」（`location.reload()`）；外层包整个 App，兜住壳自身异常（最恶劣也只白根节点一次，且带重载按钮）。用 React 类组件手写（~40 行），不引 `react-error-boundary`——依赖纪律。

**D3 chunk 失败识别在边界内做，重载按失败 URL 认领、每会话一次。** `componentDidCatch` 对 error 的 name+message 分类（`Failed to fetch dynamically imported module` / `ChunkLoadError` / `Loading chunk ... failed` / import 失败的 `TypeError` 包装）；命中且该失败 URL 未认领过 → 认领 + `location.reload()`；已认领 → 渲染错误卡。认领记录以 JSON 数组存 `sessionStorage['shell-reload-chunks']`（有界 10 条，sessionStorage 不可用回落内存）。备选：全局布尔标记 + `main.tsx` 启动清除——被否，深链落在坏 chunk 时「重载→启动清标记→再失败→再重载」构成自动循环；按 URL 认领天然满足 spec「同一失败不重复重载」，且后续真正不同代的 stale chunk 仍可自愈。

## Risks / Trade-offs

- [index.html no-cache 增加一次协商请求] → 304 极廉价（<5ms），换来的是壳永不过期错代；可接受。
- [重载循环（服务器持续故障时）] → sessionStorage 单次标记封顶；二次失败落错误卡由人决策。
- [express.static 默认头被中间层（雷池）改写] → e2e/走查以响应头为准实测，台账记录实测值；边缘若有覆盖另补配置。
- [错误分类漏掉某浏览器的 chunk 失败文案] → 分类函数集中一处 + 单测钉四型消息；漏网的落普通错误卡（仍不白屏）。

## Migration Plan

纯增量：头部与边界上线无需数据迁移；回滚 = 回退镜像。先发一支含全部三件的镜像，走查以「滚版后旧标签页点智语不白屏」为验收动作。
