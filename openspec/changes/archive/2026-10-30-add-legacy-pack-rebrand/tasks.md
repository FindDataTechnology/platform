## 1. 在仓资产改名（代码侧）

- [x] 1.1 `docs/fleet-architect.seed.json`：name 与 agent 显示名改「团队架构师（官方种子）/团队架构师」，
      persona 自称同步；`scripts/test-fleet-templates.mjs` 等钉名测试同步；en 副轨核对（已是 Team Architect）
      （**已核实在位**：现值 `团队架构师（官方种子）`/`团队架构师`；en 副轨 Team Architect 未动）
- [x] 1.2 `docs/official-packs/wanxing-fleet-assistant-manifest.json`：`萬星舰队助手`→`万星机群助手`
      （name + agents[].name + persona 自称 + 技能正文自称逐处核对）；en 副轨不变
      （**已核实在位**：现值 `万星机群助手`；en 副轨不变）
- [x] 1.3 全仓 grep 核验：在仓种子/官方包显示名无「舰队」字样；locale 门与 lint 门绿
      （**已核验**：`docs/fleet-templates/` `docs/official-packs/` `packs/*/manifest.json` `docs/fleet-architect.seed.json`
      五旧词（舰队/能力包/能力市场/智能体集群/阵列）0 命中；check:locales 全 5 语言绿）

## 2. 类目归位（代码侧，展示映射）

- [x] 2.1 线归位映射表（部署侧可配 `PACK_CATEGORY_LINES`，默认内置 daas/wire→柏讯供给、data/dash/analytics→数据、
      authoring/docs/writing→创作与文档、company→null 剔除），落点：
      `lib/pack-category-lines.js`（表 + `lineOf`/`slugsForLine`/`isLineWord`/`facetLinesOf`）；
      `gateway/packs.js` 行投影加 `line` + `list()` 按线词展开；`facet/marketplace-json.js` 插件投影归位；
      `facet/web→web/src/components/packs/PackMarketView.tsx` 分面 chip 从 `p.line` 聚合
- [x] 2.2 curation 写入端点仍收原 slug（零迁移）；单测：映射只影响展示，安装/订阅/可见性不变
      （`scripts/test-category-line-mapping.mjs`：写回 `wire` 存原 slug、`category` 字段逐字节不变、
      同一 pack 仍可见/在册；raw-slug 查询走精确匹配不受影响）
- [x] 2.3 facet 市场 e2e/单测：分面无线散词；未映射类目原样呈现
      （同上测试簇：company 从 chip 剔除；`custom-xyz` 透传；既有 `test-facet-marketplace-json.mjs` 5/5 与
      `e2e/facet-shell` 用 `legal` 未映射 slug 断言原值，逐字节兼容）

## 3. 市场运营（非代码，按需求单执行）

- [x] 3.1 长尾包发新版改名（§15.99：现网实为 22 枚含旧词/尾缀，全量普查后逐枚发新版，非需求书假设的三枚；
      旧词包名现=1 仅「投研晨会（官方种子）」与另一枚同名包冲突待产品裁，未擅动）
- [x] 3.2 六自种子新名上架核验（需求单 A2）：**2026-10-30 同日裁决收口**——投研晨会同名冲突已清（Bo2 腾位改名「投研晨会（已退役）」置私 + 官方种子 YMSt 正名 v5），市场旧词包名=0（匿名 GET total 77、投研晨会仅 1 枚在架）；六枚种子 name/en.name 已去「（官方种子）」尾与 packGuides 卡片、starter 测试钉值三层同步（test-official-starter-teams/fleet-templates/product-intro-seed 29/29 绿）；en 副轨随 `add-official-packs-i18n` 同版
      （**市场侧已先行**：六自种子现网名经 §15.99 发新版已 v4 化——AI 公司/内容流水线/客服班组/晨报情报站/投研晨会(留尾待裁)/团队架构师；
      in-repo 种子文件下次铸造时自然带上，en 副轨已在 §15.99 顺带去 Fleet· 前缀）
- [x] 3.3 验收（需求单 §5）：listing/search 无「舰队」包名 ✓（79 包 0 命中）；dash 两名可检 ✓
      （「数据 · 指标工坊」/「数据 · 自助分析」§15.67/68 已改并在架）；分面无散词 ✓（恰五线词）；主力套件零变化 ✓（仅名/描述/en.name 变）

## 4. 收尾

- [x] 4.1 `openspec validate --strict` 绿 + 全量单测绿 + locale 闸绿
- [x] 4.2 台账 `docs/registry-maintenance.md` 补发布记录（与发版班次合账）
