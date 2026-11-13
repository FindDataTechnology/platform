# wire-marketplace-json-curation

## Why

D5 定案（2026-10-12 explore，市场线文档挂账表）：Claude 原生市场面（`/api/marketplace/marketplace.json`）
的收录口径 = **公开且已策展（category 非空或 featured），与浏览面一致**。现实现只有
「公开非 unlisted」+ env 白名单（`FACET_MARKETPLACE_PACK_IDS`，未设=列全量公开包）——
「已策展」一档没接线（伞文档工程欠账 **K1**，M5.2 开门前置）。

不接的后果有实锤时间点：`PACK_ACCESS_MODE=open` 后任意登录用户可发布，Claude 原生
市场清单会被全量公开包灌满，与浏览面的策展呈现失配——收口应在开门前完成。

spec 侧 `pack-marketplace` 早已写 "lists public curated packs"，本 change 是实现向
spec 对齐 + 把 "curated" 钉死为可执行判据，不是新语义。

## What Changes

- `facet/marketplace-json.js` 收录过滤（仅清单，不动插件树路由）：
  - 默认（白名单未设）：`category` 非空 **或** `featured` 为真的公开包才进清单——
    与浏览面 facets 消费的同一对策展信号（add-facet-content-management）。
  - 白名单已设：保持现行为逐字节不变（覆写语义——运营显式点名，不经策展二次过滤）。
  - 插件树文件（plugin.json/SKILL.md/README.md）：任何公开非 unlisted 包仍可直接
    取（清单管发现，不管可达——版本不可变语义不动）。
- 分页循环保护：`loadListed` 现在的终止条件在「有包被过滤掉」时会空转扫满 50 页
  （`out.length >= total` 永不成立）——补 `packs.length === 0` 终止。
- 测试：`scripts/test-facet-marketplace-json.mjs` 默认口径改策展断言 + 新增白名单
  覆写可列未策展包的钉子。

## Impact

- 面：facet 服务一个端点的清单内容（Claude Code 插件市场视角）；浏览面/API/CLI 不动。
- 兼容：设了 `FACET_MARKETPLACE_PACK_IDS` 的部署零变化；未设的部署（含 fd-prod）
  清单从「全量公开包」收敛为「已策展子集」——这是 D5 定案的预期行为变化，开门后
  即为正确形态。fd-prod 现网 19 包首轮垂类归类已覆盖绝大多数，清单收缩有限（生产
  实证核对）。
- 关联：伞文档工程欠账清单 K1（修毕销账）；市场线 D5（落地转 ✅）。
