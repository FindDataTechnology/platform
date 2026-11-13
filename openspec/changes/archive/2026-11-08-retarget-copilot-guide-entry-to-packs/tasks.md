# Tasks — retarget-copilot-guide-entry-to-packs

## 1. 代码

- [x] 1.1 `web/src/components/CopilotDock.tsx`：facet 线判据加入 `/packs`（旧 `/agents?tab=market` 保留为书签档）
- [x] 1.2 注释说明这条映射为何必须跟着市场面走（W2 teardown 拆了中心页）

## 2. 测试

- [x] 2.1 `e2e/copilot-dock.spec.js` 两条 market 用例改到 `/packs`（原断言面已不存在）
- [x] 2.2 反证：摘掉 `/packs` 判据并重建 bundle → 两条转红（2 failed / 5 passed），恢复后 md5 一致再绿
- [x] 2.3 `copilot-dock.spec.js` + `onboarding.spec.js` 16/16 绿

## 3. spec 与归档

- [x] 3.1 `specs/pack-marketplace/spec.md` MODIFIED「The 壹座 Store tab carries a market guide entry」：面名指到 `/packs`，五个场景逐条保留
- [x] 3.2 `openspec validate retarget-copilot-guide-entry-to-packs --strict`
- [x] 3.3 `openspec archive retarget-copilot-guide-entry-to-packs`
