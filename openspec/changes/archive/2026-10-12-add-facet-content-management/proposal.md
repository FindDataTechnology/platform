# add-facet-content-management

## Why

谦面的定位是「创作→策展→分发」（facet-wanxing-roadmap），但现实只有分发：创作面（发布/版本/下架/可见性）只长在壹座的设置里，策展面（垂类/精选）哪里都没有——19 个在架 pack 平铺按时间倒序，观测面（用量遥测）在 ops 台的壹座 admin 域。用户裁定（2026-10-12，「尽量完善」= C 档）：谦面要有自己的完整内容管理，成为真正独立的模块。架构事实支持这一步：pack registry 本就归屋 facet（ADR-0015），publish/unpublish/列表/详情 API 在 facet 服务端全部已服务，缺的只是 UI 与策展字段；cell 组装式创作（草稿/装机）按 D8 语义留在壹座。

## What Changes

- **作者面（创作管理）**：谦面壳新增 `#/mine` 视图（登录创作者可见）——我发布的包（作者过滤列表）、版本历史、下架/恢复（unlisted 语义）、private/public 可见性切换、以及「从清单发布」入口（粘贴/上传 manifest JSON 走既有 POST /api/packs，含校验错误透传）。不搬壹座的装机面（/api/mypacks 在谦面保持 501 软拒）与 cell 草稿面。
- **策展面**：packs 表新增 `category`（垂类 slug，作者可在发布/管理时声明，admin 可改）与 `featured`（精选，仅 admin）两列；listing/详情/marketplace.json 带出两字段并支持 `?category=` 过滤；admin 专用 `PUT /api/packs/:id/curation`。市场视图呈现垂类过滤 chips + 精选位（置顶区）；谦面壳新增 `#/curate` 策展板（admin 可见：全量包列表 + 垂类/精选在线改）。
- **观测面**：facet 代理壹座网关的 `/api/ops/pack-usage` 聚合（PACK_USAGE_TOKEN 服务凭据、集群内 service 直连），谦面 `#/curate` 板上呈现每包周活跃/回合数——供给决策（M1 出口 ≥5 周活跃）第一次在谦面域可读。
- **壳视图扩展**：tab 条从固定三枚变为「intro/packs/mcp + 登录态条件 tab（mine）+ admin 条件 tab（curate）」，hash 路由语义不变（`#/mine`、`#/curate` 深链可刷新）。
- 配套：哨兵 e2e 扩展（匿名只见三 tab；seeded creator/admin 会话下 mine/curate 渲染）；路线图 M1「轻通用市场功能」决策按本次用户裁定修订（运营面服务垂直内容主线，非泛用市场功能）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `facet-platform`：
  - MODIFIED「Shell views are addressable hash routes」——三视图扩为「三公共视图 + 身份条件视图（#/mine 创作者、#/curate admin）」，未知 hash 回落 intro 不变；既有四场景全保留，新增条件视图场景。
  - ADDED「The facet surface carries a creator console」——作者面（我发布的/版本/下架/可见性/从清单发布）在谦面域可达，装机仍归壹座。
  - ADDED「Curation is a facet-admin surface」——垂类与精选是 admin 专属管理动作；市场按垂类过滤、精选置顶呈现。
  - ADDED「Pack usage is readable on the facet surface」——每包用量聚合（周活跃/回合）经 facet 代理在策展板可读。
- `pack-marketplace`：
  - ADDED「Packs carry a curation category and featured flag」——两字段的语义、权限（category 作者可声明 admin 可改、featured 仅 admin）、listing/详情/marketplace.json 透出与过滤。
  - MODIFIED「Publishing is identity-gated」——既有两场景保留；明确「从清单发布」与 cell 组装发布走同一身份门与校验（新场景）。
  - MODIFIED「Browse, search, and inspect」——浏览呈现垂类 chips 与精选位（新增场景，既有五场景全保留）。

## Impact

- `gateway/packs.js`：packs 表加 category/featured 两列（ALTER 兼容存量）+ curation 写入路由 + listing/detail/marketplace-json 带出 + `?category=` 过滤 + 作者过滤参数。
- `facet/web/src/`：MineView（新）、CurateView（新，含用量板块）、App tab 条条件化。
- `facet/index.js`：/api/ops/pack-usage 代理路由（env：PLATFORM_INTERNAL_URL + PACK_USAGE_TOKEN）。
- 部署：facet deployment 增 env；壹座网关无需改（聚合路由已在）。
- 观测代理方向说明：壹座→facet 的既有内部通道方向不变；新增 facet→platform 的只读集群内调用（同 namespace service 直连 + 服务凭据）。
- 修订 docs/facet-wanxing-roadmap.md M1 决策注记。
