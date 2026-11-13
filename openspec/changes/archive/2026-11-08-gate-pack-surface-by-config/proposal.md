# 市场面只在网关前置部署出现——把 D15 从注释落成守卫

## Why

`add-pack-marketplace` 的 design D15 定了这条边界：市场面（浏览/订阅/创作/发布）
只在网关前置部署出现，本地部署没有市场可连。实现方式一直是「挂载点自带条件」——
最初是 agents 中心页的 Tab 数组（`activeCabinet === "packs" && packMarketplace`）。

2026-11-06 的 W2 teardown 拆了那个四区中心页，2026-11-07 又把 `PacksPage` 以
独立路由 `/packs` 恢复（add-supply-studio-migration 5.2，`6efaf631d`）。恢复时只搬了
页面，没搬挂载条件：`App.tsx` 的 `<Route path="/packs" element={<PacksPage />} />` 是
无条件的，而 `PacksPage` 的头注释仍写着「Mounted only when config.packMarketplace is
true」——那句话从那天起就是假的。

后果是本地部署（`PACK_MARKETPLACE` 未开）访问 `/packs` 会看到完整的市场壳：市场
列表、我的包、创作/发布草稿箱，全都指向一个不存在的市场域。e2e 里
「pack surfaces disappear when the deployment is not gateway-fronted」这条测试一直
红着，但它断言的是旧 IA 的 `agents-tab-*`，所以红得像是「测试过期」，掩盖了真缺陷
（审计 optimize-paas-module-audit 的 N-10 就是让这个文件整体转绿）。

## What Changes

- `web/src/pages/PacksPage.tsx`：`packMarketplace` 为假时 `Navigate` 到 `/agents`
  （现 agent-market 门面），守卫落在面自己的门口——深链解析到有人住的地方，不是空壳。
  `/api/config` 在首绘前就取（`main.tsx`），首次渲染时该标志已正确，不会误跳。
- `openspec/specs/pack-marketplace/spec.md`：新增需求「市场面只在网关前置部署出现」，
  含「本地部署访问市场深链」场景。
- `e2e/packs.spec.js`：那条 D15 测试改写到当前 IA（`/packs` → 落到 `/agents`，
  `packs-page` 与 `packs-tab-market` 均不存在）。反证：摘掉守卫后该测试转红。

非目标：不改市场面的内容与权限；不动 `/agents` 的已装包面板（那是运行域，两个部署
形态都该有）；不恢复中心页。

## Impact

- 影响面：只有 `PACK_MARKETPLACE` 未开的本地部署——它们的 `/packs` 深链从空市场壳
  改为落到 agent-market 门面。网关前置部署行为不变。
- 无迁移、无数据变更。
