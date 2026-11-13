## Why

谦面市场（facet 的 智能体 页与壹座 Store 面共用一个 `PackMarketView`）是这条产品线最重要的门面，但今天三件事同时坏着：

1. **多语言是"提交了但不显示"**。作者为 57/75 个在架包提交了 `i18n` 副轨（53 条 en name、52 条 en description），但切换界面语言后市场**不重新取数**（`PackMarketView` 的 `refresh` 只依赖 `category`，`PackDetailDialog` 只依赖 `packId`，`packs-api` 只在调用瞬间读 `i18n.language`），卡片与详情保持上一次的语言直到手动搜索或重开。分类标签（"柏讯 · 数据与情报"）根本不在多语言轨道里——`lib/pack-category-lines.js` 硬编码中文线词，实测 `?locale=en` 与 `?locale=zh` 返回的 `line` 逐字相同。tags 不在覆盖白名单（`LOCALE_OVERLAY_KEYS` 无 `tags`），英文访客看到 `["柏讯","量化","策略","回测","wire"]`。搜索只打 zh 列（`v.name LIKE ?`），实测 `search=strategy&locale=en` 命中 0 条。en 下仍有 23/75 个包漏中文，技能描述 141/202 有覆盖。

2. **分类 tab 会自己变形**。同一行 chip 里塞了两个正交轴：`line`（谁供给的线）与 `category`（干什么活的领域 slug），未映射的 slug 原样透出，`company`/`facade` 映射为 null 后整个包在分面里消失。chip 集合来自"当前返回数据里出现过的值"（`listPacks({pageSize:100})` 的 `Set`）而不是声明的目录，于是上架/下架/改策展都会让 tab 行增删，超过 100 条还会截断；顺序是 `sort()` 按码点排中英混排字符串。

3. **卡片是"一段散文"**。description 中位 152 字、最长 678 字，被 `line-clamp-2` 硬切；manifest 里没有任何图标/封面/主题色字段（全仓 grep 无 `icon|cover|logo|image`），70 张卡片只能靠读字区分；技能数/角色数/工具数都在 payload 里却一个都不显示；71/75 都挂"官方"徽章（`featured` 只有 2 条），两个最强信号同时失效；detail 是一堵墙（描述 → 标签 → 全量技能正文 → 版本列表），没有首屏承诺、没有可点示例、没有独立的"边界与诚实声明"位。

同时，作者端**根本没有多语言入口**——`PackDraftsView` 唯一的 i18n 能力是 `i18n.en.mcpServers[].description`，name/description/skills 只能手改 manifest 或用 bundle/CLI 发布。所以"以后上传的内容和格式"必须一起改，否则补完这 75 条，下一条上架又回到零点。

## What Changes

- **读面按语言重取**：市场列表与详情在界面语言变化时重新请求（服务端仍是唯一的 locale 解析点，客户端只声明语言）。
- **分类体系从"数据的副产品"变成"声明的契约"**：拆成两个正交轴——**线**（供给方，5 值固定，多语言）与**领域**（干什么活，受控词表，可多值，多语言）；分面 chip 来自目录而非数据出现集，顺序固定、带计数、恒在；裸 slug 不再进分面。
- **`line` / `domain` / `tags` 进入多语言轨道**：服务端按请求 locale 投影标签，标签词表迁移到受控词表（消除 `柏讯` 与 `wire` 并存的同义重复）。
- **搜索跨语言轨道**：`?locale=en` 的搜索同时命中 zh 主轨与当前 locale 的覆盖文本。
- **市场卡片改为五槽位**（身份 / 一句话承诺 / 可得信号 / 适用人群 / 边界行），**详情改为七段式**（承诺 → 你会得到 → 三步上手 → 可点示例 → 角色/技能/工具 → 边界与诚实声明 → 版本时间线 + 常驻安装 CTA）。
- **manifest 显示格式 v2（��部可选、零迁移）**：新增 `identity`（印章式标识 + 线色令牌）、`promise`（≤60 显示宽）、`audience[]`（受控词表）、`outcomes[]`（2-5 条结果）、`examples[]`（2-4 条可点示例）、`domain[]`；`i18n` 覆盖白名单同步扩容。老 manifest 不写这些字段时渲染结果与今天逐字节相同。
- **视觉身份默认服务端生成**：按"线 + 结构"生成印章式标识（复用 `SiteMark` 的印章语言），`identity.mark` 只作作者覆盖；不引入图片上传、不出审核面。
- **作者端翻译工作台**：编辑器内 zh 与目标语言并排、逐字段覆盖率、缺项清单一键定位；保存走既有 `entries.i18n` 通道。
- **覆盖度成为可见约束**：社区条目的卡片/详情呈现"本条目 en 覆盖 n/m 组织面"的诚实标记；官方资产在架全量走硬门（`official-locale-coverage` 从 4 个在仓 json 扩到在架官方条目）。

## Capabilities

### New Capabilities

- `pack-display-format`: manifest 的 v2 显示格式契约——`identity` / `promise` / `audience` / `outcomes` / `examples` / `domain` 的形状、上限、校验、缺省降级，以及"不写就逐字节不变"的兼容不变量与各投影（市场读面、详情、安装面、CodeBuddy 市场仓 sidecar）的透传规则。
- `pack-domain-taxonomy`: 领域轴——受控词表（slug + 五语标签）、多值声明、策展只可从词表选择、分面按词表顺序与计数呈现、未在词表内的历史值迁移策略。

### Modified Capabilities

- `pack-locale-tracks`: 叠加块白名单扩容（`promise` / `audience` / `outcomes` / `examples` / `domain` / `tags` / `identity.mark.value`），并在既有"zh 主轨 + 顶层叠加块"需求内补场景；结构字段（`accent`、`kind`）永不进入叠加块。
- `pack-marketplace`: 新增"卡片五槽位"、"详情七段式"、"语言变化后重新取数"、"搜索跨语言轨道"、"分面来自声明体系"、"官方徽章收敛"六条需求。
- `pack-category-line-mapping`: 线词改为多语言标签；分面集合改为声明式（未映射 slug 不再原样进分面）。
- `official-locale-coverage`: 在架官方条目的覆盖审计门（不只是 `docs/official-packs/*.json` 与 `packs/*/manifest.json` 这些在仓文件）。
- `pack-authoring`: 草稿编辑器的多语言翻译面、领域从受控词表选择、发布前覆盖率提示。

## Impact

- **读面**：`web/src/components/packs/PackMarketView.tsx`、`PackDetailDialog.tsx`、`AgentSpecSheet.tsx`（新卡片/详情呈现）、新增卡片与标识组件；`web/src/lib/packs-api.ts`（语言变化重取、领域参数）。`facet/web/src/App.tsx` 复用同一组件，**不得引入 react-router 依赖**（facet 壳无 Router 祖先，这是 2026-10-21 白屏的回归类）。
- **服务端**：`gateway/packs.js`（列表查询跨轨道搜索、分面目录端点/字段、`domain` 投影）、`lib/pack-manifest.js`（v2 字段校验 + 白名单扩容）、`lib/pack-locale.js`（投影新字段与标签）、`lib/pack-category-lines.js` → 迁移为多语言线与领域词表、新增 `lib/pack-taxonomy.js`。
- **数据**：`packs.db` 的 `category` 列零迁移（写面语义不变）；领域轴以 manifest 字段 + 策展列承载；历史 14 个 category slug 归位由迁移脚本一次性完成并留审计。
- **门与测试**：`scripts/check-locales.js`（五语 parity，新增标签键）、`scripts/test-category-line-mapping.mjs`、`scripts/test-pack-registry.mjs`、`scripts/test-official-showcase.mjs`、`scripts/test-facet-marketplace-repo.mjs`、新增 `scripts/test-pack-display-format.mjs` / `scripts/test-pack-taxonomy.mjs` / `scripts/test-market-locale-refetch.mjs`、`e2e/packs.spec.js`。
- **外部投影**：`facet/marketplace-repo.js` 的 `marketplace.json` / `plugin.json` 结构是 CodeBuddy 客户端的硬格式（name/description/version 必须一致），新字段**不进** marketplace.json，改放插件目录下的 `facet.json` sidecar（与 `libraryPins` 纯透传同一纪律）。
- **呈现纪律**：受 `facet/web/DESIGN.md` 约束——12px 字号下限、任意值白名单登记、动效三白名单、五语 parity 硬门、`prefers-reduced-motion` 豁免。
- **不改**：packId、技能名、MCP `registryName`、组闸、计费键、安装/订阅/可见性语义，以及技能正文与 persona 的内容层语言（停在显示面）。
