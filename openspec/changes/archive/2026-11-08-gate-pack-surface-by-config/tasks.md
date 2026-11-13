# Tasks — gate-pack-surface-by-config

## 1. 代码

- [x] 1.1 `web/src/pages/PacksPage.tsx`：`packMarketplace` 为假 → `Navigate to="/agents"`，守卫落在页面自身
- [x] 1.2 头注释改写：说明守卫为何在页面里（挂载点随 IA 搬迁，边界不该跟着丢）

## 2. 测试

- [x] 2.1 `e2e/packs.spec.js` D15 一条改写到当前 IA：`/packs?tab=market` → URL 落 `/agents`、`agent-market-page` 可见、`packs-page`/`packs-tab-market` 计数 0
- [x] 2.2 反证：摘掉守卫并重建 bundle → 该条转红（停在 `/packs?tab=market`），恢复后字节一致（md5 一致）再绿
- [x] 2.3 `e2e/packs.spec.js` 全文件 25/25 绿（含工具面那条把 catalog mock 的 glob 补成 `market*`——`?locale=en` 才匹配得上）

## 3. spec 与归档

- [x] 3.1 `specs/pack-marketplace/spec.md` ADDED「市场面只在网关前置部署出现」+ 两个场景
- [x] 3.2 `openspec validate gate-pack-surface-by-config --strict`
- [x] 3.3 `openspec archive gate-pack-surface-by-config`
