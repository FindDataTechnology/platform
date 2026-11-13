## Why

智语页偶发整页白屏（用户走查问题①，现可自愈）——根因不在智语页自身（其数据错误处理已健壮），而是 SPA 壳的结构性脆弱，三因叠加：

1. 网关与单进程 server 以 `res.sendFile` / `express.static` 默认头提供 `index.html`——**无 Cache-Control**，浏览器按启发式缓存旧壳；
2. 全部路由为 `lazy()` 动态加载，chunk 文件名含内容哈希——每次滚版，被改过源码的页面 chunk 即改名；
3. `web/src` 全仓 **ErrorBoundary 出现 0 次**——任何一次动态 import 失败或渲染抛错 = 整棵 React 树卸载 = 全页白屏（连侧边栏一起消失）。

叠加效果：滚版后旧壳客户端点击「chunk 恰好改过名」的页面（批②重写了 ZhiyuPage/AppCenterPage 等六页，MachinesPage 不在其列）→ 旧 chunk 404 → 无边界 → 白屏；硬刷新或再滚一版自愈——与「偶发、现在又能打开」的现象吻合。不修则每次滚版都会以不同页面重演。

## What Changes

- 壳缓存姿态：`index.html` 响应附 `Cache-Control: no-cache`（每次协商），`assets/` 带哈希产物附 `public, max-age=31536000, immutable`——gateway 与单进程 server 两处同改。
- 全局渲染边界：App 根部加 ErrorBoundary——路由级渲染崩溃降级为内容区错误卡（重试 / 重新加载两出口），侧边栏与壳保持在场；不再整树卸载。
- chunk 失败自愈：识别「动态 import 失败 / Loading chunk failed」类错误 → 自动整页重载**一次**（sessionStorage 防环，重载后仍失败则落到错误卡）。
- 错误卡与降级文案五语齐全（en/es/fr/ja/zh-CN），走 check-locales 门。

## Capabilities

### New Capabilities

- `web-shell-resilience`: SPA 壳的容错契约——壳与哈希资产的缓存姿态、渲染崩溃的页内降级、chunk 加载失败的一次性自愈。

### Modified Capabilities

（无——`web-chat-server` 的深链回退需求本身不变，缓存姿态作为新能力的需求陈述。）

## Impact

- `gateway/index.js`（`express.static` + SPA fallback `sendFile` 的响应头）
- `server.js`（单进程 server 的静态服务与深链回退，同形态两处）
- `web/src/App.tsx` / `web/src/main.tsx`（ErrorBoundary 挂位）、懒加载 import 错误识别（vite chunk 错误钩子）
- `web/src/locales/{en,es,fr,ja,zh-CN}/common.json`（`shell.*` 新键五语）
- `web/e2e/`（白屏哨兵：模拟 chunk 失败与渲染抛错）
