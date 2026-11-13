## Context

BoardsPage（`/boards/:line`）现以 `window.location.hash = tab` 驱动页签、以 `block.id.includes(currentTab)` 猜块归属；`lib/board-adapters.js` 的 FacetBoardAdapter 返回硬编码占位（`weeklyActivePacks: 0`），MetricsBlock 把数据键原文当标签。三块适配器（facet/wanxing/wire）与渲染器之间的「块-页签-标签」契约从未在 spec 里定义，全靠 id 命名默契——谦面页签连字符 vs 块 id 下划线即默契破裂的产物（见 proposal.md - Why）。

## Goals / Non-Goals

**Goals:**
- 页签切换可分享（URL 带页签）但零历史污染；回退键一步离开看板。
- 块-页签归属成为数据契约（适配器声明），渲染器不再猜。
- 指标标签走 i18n，五语无裸键。
- 谦面看板要么真数据、要么如实「建设中」。

**Non-Goals:**
- 不重做动作闸（`/api/actions/propose` 链路维持，见 `action-gate`）。
- 不改副驾 dock 的聚焦预设解析（`line-boards` 既有条文不动）。
- 柏讯/萬星两线不动数据源，只随契约升级改块声明形态。

## Decisions

**D1 页签用 `history.replaceState` 保 hash，不用 router state。** `onClick={() => history.replaceState(null, '', '#'+tab)}` + 保留现有 `hashchange` 监听（深链 `#publish-history` 仍可直达）。replaceState 不压历史 → 回退键直接回 `/apps`；hash 留在 URL → 分享/刷新保页签。备选：`useSearchParams`——被否，与既有深链形态（hash）不兼容，改动面更大。

**D2 块契约加 `tab` 字段，适配器声明；渲染器 `block.tab === currentTab` 精确匹配，无 `tab` 时回落归一化匹配（`id.replace(/-/g,'_')`）。** 服务端 `Board` 类型与 `server/routes/boards.js` 透传该字段。归一化回落让 wanxing（块 id 恰好等于页签名）零改动即正确，facet 的 `my_packs`/`publish_history` 经归一化即命中 `my-packs`/`publish-history`。备选：全适配器补 `tab` 不留回落——被否，回落是防御性契约，避免下次改名再翻车。

**D3 指标标签走 i18n 键表，数据键改 snake_case。** 块形态：`data: Record<string, number|string>` 不变，新增可选 `labels: Record<key, string>`（标签键，渲染器 `t('board.metric.'+labels[key], { defaultValue: key })`）。wire 的中文键（`数据集`）改为 snake_case（`datasets`/`artifacts`/`demands`/`quota`）+ 五语 `board.metric.*` 新键；facet 用 `weekly_active_packs`/`total_installs`。备选：适配器直发本地化文本——被否，服务端无请求语言上下文，且违反「表现层走词表」的地基契约（`web-design-system`）。

**D4 谦面真数据走 facet 市场凭据直读，未就绪块诚实降级。** FacetBoardAdapter 复用 `facet-market-credentials` 车道读市场统计与我的包；上游无对应端点的块（如周活跃）渲染 `error: 'under_construction'` 形态，前端呈现「建设中」+原站深链，MUST NOT 出现 0。备选：暂时保留占位但标注——被否，spec 已禁伪造数据，占位即违例。**探针收口（apply 2026-11-02）**：市场读面实测无「周活跃/总安装」端点（`/api/ops/pack-usage` 是 admin 门），但「我的包数 / 已发布版本数」可从 `/api/packs?author=me` + `/api/packs/:id/versions` 如实导出——概览块因此呈现真计数，无端点的两指标直接不呈现（spec 已同步此结局）。`under_construction` 卡机制保留，现由萬星看板（无凭据车道）消费。

**D5 BoardsPage 迁 PageShell。** 页头 = PageShell（title=看板名，actions=[返回应用中心（navigate('/apps')，testid `board-back`）、打开原站]），未连接态用 EmptyState/StatusPill 词汇。与批②五面对齐。

## Risks / Trade-offs

- [facet 市场统计端点可能不存在] → D4 的「建设中」降级是设计内结局，不算失败；真端点就绪后只改适配器一处。
- [replaceState 与浏览器前进键的边角（前进到被 replace 的 hash 态）] → 前进键同样只动 hash，页签初始化读 hash 兜底，无白屏风险。
- [wire 数据键改 snake_case 是对外契约变更] → 块 JSON 仅 BoardsPage 消费（无第三方），单测同步钉新键即可。
- [归一化回落可能掩盖未来真正的 id 拼写错误] → 回落仅在 `tab` 字段缺席时生效；新块强制带 `tab`，回落逐步退役。

## Migration Plan

纯前端 + 适配器形态变更，无数据迁移。回滚 = 回退镜像。验收走查：从 `/apps` 进柏讯看板 → 点三页签 → 回退键一步回 `/apps`；谦面三页签均有块或如实降级；全页无英文裸键。

## Open Questions

（无——原「facet 是否有周活跃统计端点」的探针问题已在 apply 时以现网读面收口，见 D4 探针注。）
