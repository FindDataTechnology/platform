## Why

`define-agent-document` 已声明「任何展示 agent 的面都必须把三桶作为一个单元呈现」，但今天四个展示面各画各的：`PackDetailDialog` 铺全文技能正文与 persona，`AssistantPicker` 只给名字与徽章，`packGuides.ts` 把引导硬编码在客户端，官方 showcase 只多一枚 official 徽章。同一个 agent 在四个地方长四个样，官方智能体因此「读不懂」，用户也无法从展示里学到「它由哪三桶构成」。

本 change 交付**一个共享的三桶规格书（spec sheet）组件与契约**：所有展示面供给数据、不重排三桶；三桶恒显（空桶也显式呈现）；类型徽章与 provenance 由结构与 roster 合成，作者不可自报。这是让「官方 agent 展示优化」与「谦面可看懂」的第一块地基。

## What Changes

- **新增共享规格书契约 `agent-spec-sheet`**：一个组件，多处消费——市场详情、对话选择器、Studio 右栏预览、后续官方 gallery。展示面只传数据，不得自定三桶布局。
- **三桶恒显**：角色（persona 摘要 + 可展开全文）、技能（列表 + 可展开正文）、工具（MCP 引用 + 工具面计数/收窄）。任一桶为空时**显式呈现为空**，不得省略该桶。
- **徽章与 provenance 单点合成**：类型徽章由 manifest 结构推导（作者不可覆盖，沿用 `lib/pack-badge.js`）；provenance 三轴（类型/官方性/来源）由 `lib/pack-provenance.js` 合成，官方身份只来自 roster，`adopted` 需 roster + manifest 同时成立。
- **引导来自数据**：`guide` 存在时按 `manifest.guide` 渲染三步；缺失时不渲染引导块（不在客户端补写文案——文案迁移是 `move-pack-guides-to-manifest` 的活）。
- **两面同源**：壹座与谦面 facet 复用同一组件，同一 agent 渲染一致。
- **明确 Non-goals**：不改三桶的数据形状；不做克隆/血缘（`add-agent-fork-lineage`）；不迁移 `packGuides.ts` 的存量文案；不做官方 gallery 的编排（`add-official-agent-gallery` 消费本组件）。
- **非 BREAKING**：市场详情的可展开全文能力保留，只是布局收敛到规格书契约。

## Capabilities

### New Capabilities
- `agent-spec-sheet`: 三桶规格书的展示契约——恒显三桶、徽章与 provenance 的单点合成、引导来自文档数据、跨壹座/谦面同一渲染，以及消费面清单（市场详情、选择器、Studio 预览、官方 gallery）。

### Modified Capabilities
<!-- 无：展示契约以新能力定义；既有 pack-marketplace/agent-catalog 的需求文本不改，
     仅其展示实现改为消费本组件。 -->

## Impact

- **Web（共享层）**：新增 spec-sheet 组件（放壹座与 facet 都能 import 的共享位置），替换 `PackDetailDialog` 的展示布局与 `AssistantPicker` 的 agent 行细节。
- **复用**：`lib/pack-badge.js`、`lib/pack-provenance.js`（服务端合成后下发，或客户端只做展示投影——以实现口径为准，规则不重写）。
- **Facet**：`PackMarketView`/`PackDetailDialog` 已被 facet 逐字复用，组件进共享层后两面自动一致。
- **下游**：`add-agent-studio`（D3 右栏预览复用）、`add-official-agent-gallery`（官方 gallery 复用）。
