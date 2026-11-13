## 1. 块-页签-标签契约（数据侧）

- [x] 1.1 `lib/board-adapters.js` 三适配器为每块补 `tab` 字段（facet: overview/my-packs/publish-history；wire: overview/datasets/artifacts/demands；wanxing 维持页签名=块名）；`server/routes/boards.js` 透传该字段；单测钉每块带 tab
- [x] 1.2 wire 适配器数据键由中文改 snake_case（`datasets`/`artifacts`/`demands`/`quota`），块新增 `labels: Record<key, labelKey>`；facet 指标键 `weekly_active_packs`/`total_installs` 同带 labels；单测钉键形态
- [x] 1.3 FacetBoardAdapter 接 facet-market 真读面（复用 `facet-market-credentials` 车道，凭据缺失走未连接态）；上游无端点的块返回 `error: 'under_construction'` 形态，移除全部硬编码占位值；单测钉「无占位假数据」

## 2. 渲染器（BoardsPage）

- [x] 2.1 页签切换改 `history.replaceState(null,'','#'+tab)`，保留 `hashchange` 监听与初始化读 hash；验证：点三页签后浏览器回退键一步回 `/apps`（e2e）
- [x] 2.2 块过滤改 `block.tab === currentTab`，`tab` 缺席时回落归一化匹配（`id.replace(/-/g,'_') === currentTab.replace(/-/g,'_')`）；单测钉谦面 `my-packs` 页签命中 `my_packs` 块、确无块时呈现页签空态
- [x] 2.3 MetricsBlock 标签走 `t('board.metric.'+labelKey, { defaultValue: key })`，MUST NOT 渲染数据键原文；单测钉四型指标标签均解析
- [x] 2.4 BoardsPage 迁 PageShell：title=看板名，actions=[返回应用中心（testid `board-back`，navigate('/apps')）、打开原站]；未连接态用 EmptyState/StatusPill 词汇
- [x] 2.5 `web/src/locales/{en,es,fr,ja,zh-CN}/common.json` 补 `board.metric.*`、`board.back`、`board.underConstruction` 键，check-locales 门五语一致

## 3. 验证与收口

- [x] 3.1 e2e 看板 spec：柏讯三页签切换→回退一步到应用中心；谦面三页签各有块或如实「建设中」；全页无英文裸键（DOM 文本断言）
- [x] 3.2 真机走查（生产）：从应用中心进柏讯/谦面看板，页签/回退/返回控件/指标标签逐项眼见，证据入台账 `docs/registry-maintenance.md`
