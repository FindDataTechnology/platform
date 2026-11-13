## 1. 壳缓存姿态（服务端）

- [x] 1.1 新建零依赖叶模块 `lib/spa-static-headers.js`：导出 `applySpaHeaders(res, filePath)`——`assets/` 含哈希 → `public, max-age=31536000, immutable`，其余与壳 → `no-cache`；单测钉两型头值
- [x] 1.2 `gateway/index.js` 的 `express.static` 挂 `setHeaders` 调该模块，SPA 回退 `sendFile` 传 `no-cache` 头；本地起 gateway curl -I 实测 `/`、`/zhiyu`、`/assets/<hash>.js` 三型响应头
- [x] 1.3 `server.js`（单进程 server）的静态服务与深链回退同法接入同一模块；curl 实测同上三型

## 2. 渲染边界与自愈（客户端）

- [x] 2.1 新建 `web/src/components/ShellErrorBoundary.tsx`（类组件）+ 零依赖叶 `web/src/lib/chunk-failure.ts`：错误分类识别 chunk 失败四型消息（`Failed to fetch dynamically imported module` / `ChunkLoadError` / `Loading chunk` / Safari `Importing a module script failed`）；chunk 失败且该失败 URL 未认领过 → 认领（sessionStorage `shell-reload-chunks`，有界 10 条）+ reload；否则渲染错误卡（重试=重置边界，重新加载=location.reload()）；单测 `scripts/test-chunk-failure.mjs` 钉分类与防环逻辑
- [x] 2.2 `web/src/App.tsx` 布局内层：`<Suspense>`+`<Routes>` 子树包内层边界（侧边栏在边界外），错误卡走 states-kit 词汇，testid `shell-error-card`
- [x] 2.3 `web/src/main.tsx` 根部外层边界兜底整树（最恶劣呈现带重载按钮的根错误页）
- [x] 2.4 `web/src/locales/{en,es,fr,ja,zh-CN}/common.json` 补 `shell.error.*` 键（标题/说明/重试/重新加载），check-locales 门五语键集一致

## 3. 验证与收口

- [x] 3.1 e2e 哨兵：拦截并破坏某懒路由 chunk 请求 → 断言自动重载一次不循环、二次失败落 `shell-error-card`；渲染抛错夹具路由 → 断言侧边栏在场、错误卡两出口可用
- [x] 3.2 真机走查（生产滚版后）：旧标签页点智语/应用/机器不白屏；curl -I 生产壳与资产响应头留证据入台账 `docs/registry-maintenance.md` 发布记录
