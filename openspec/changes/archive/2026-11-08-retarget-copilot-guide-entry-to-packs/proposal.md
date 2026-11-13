# 市场引导入口跟着市场面搬到 /packs

## Why

`pack-marketplace` 的「The 壹座 Store tab carries a market guide entry」把引导入口钉在
「壹座 Agents 页的 Market 页签」上，包括场景一里的 `/agents?tab=market`。那个页签随
2026-11-06 的 W2 teardown（`0eb48a0d0`）拆掉了：`/agents` 现在是 AgentMarketPage
（供给域深链 + 已装包面板），市场面本体在 `/packs`（11-07 以独立路由恢复，`6efaf631d`）。

结果是一条活需求描述了一个不存在的面：`CopilotDock` 的 facet 线只在
`/agents?tab=market` 上解析，站在真正的市场面 `/packs` 上开坞却拿不到 谦面助手 预设
——这个面的全部契约就是「带着谦面助手说话」，却在搬家时把这半条丢了。e2e
`copilot-dock.spec.js` 的两条 market 用例因此一直红着（`board=facet` 缺失 / 空 URL）。

本次把代码补回、把需求措辞指到现役面上；不为旧页签保留双实现——旧 URL 只是继续
映射到 facet 线，让老书签不突然变成无上下文的坞。

## What Changes

- `web/src/components/CopilotDock.tsx`：facet 线判据加入 `/packs`（保留
  `/agents?tab=market` 旧书签档），注释说明为什么这条映射得跟着市场面走。
- `openspec/specs/pack-marketplace/spec.md`：MODIFIED 该需求——面名从「Agents 页
  Market 页签」改为市场面 `/packs`（旧深链仍映射），五个场景逐条保留，场景一的
  WHEN 指向 `/packs`。
- `e2e/copilot-dock.spec.js`：两条 market 用例改到 `/packs`（原断言面已不存在）。
  反证：摘掉 `/packs` 判据后两条转红（2 failed / 5 passed），恢复后 md5 一致再绿。

非目标：不改引导内容（内容已随 move-pack-guides-to-manifest 3.3 进入 manifest）；
不动已装包面板；不恢复旧的四区中心页。

## Impact

- 影响面：壹座市场面（`/packs`）上的 copilot 坞从此解析 facet 线——这是 add-facet-copilot
  原本的市场语义，只是搬家时掉了。其他路由的坞仍无上下文档。
- 无迁移、无数据变更。
