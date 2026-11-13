## Why

`web/src/lib/packGuides.ts`（333 行）把多支官方 pack 的三步引导与文案**硬编码在客户端**、按 pack id 索引。而 `manifest.guide` 通道早已存在（校验器钉住三步形状），`official-starter-teams` spec 更已明令「说明卡数据与种子 manifest 同源（零第二真源）」。现状是内容当代码：官方改一句引导要重发前端；谦面 facet 读不到同一份文案；`add-agent-spec-sheet` 的「引导来自文档数据」契约也要求内容先归位 manifest。

## What Changes

- **存量 guide 文案迁入 manifest.guide**：为文案只在客户端的 pack（法律-合同、法律-案件等）补写 `guide` 三步并发新版本（版本不可变，编辑=发 vN+1）；官方资产同时补 `i18n.en` 副轨（沿 `pack-locale-tracks` 既有契约）。
- **消费面全部改读文档数据**：市场详情引导卡、官方 starter 说明卡、聊天欢迎态引导呈现，改从 detail/catalog 下发的 manifest 数据渲染。
- **`packGuides.ts` 的 guide 职责退役**：归档后客户端**零按 pack id 索引的引导文案**；文件内保留的欢迎态 prompt 建议卡不受影响（见 Non-goals）。
- **明确 Non-goals**：**欢迎态四张 prompt 建议卡不迁**——它们是「怎么开始」的 chrome 建议，迁移需扩 manifest 形状（动发布门），单独立项再议；不改 `guide` 字段形状；不动发布门/校验器规则。
- **非 BREAKING**：guide 缺失的 pack 渲染行为不变（无引导块）。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `pack-marketplace`: 新增一条需求——guide 内容单点存于 manifest，客户端不得携带按 pack id 索引的引导文案；消费面从文档数据渲染，缺失即不渲染。

## Impact

- **内容迁移**：涉及 pack 需发新版本（官方优先）；en 副轨录入走既有 i18n 叠加块契约。
- **Web**：`PackDetailDialog`、`ChatWelcome`、`HelpDialog` 三处消费面切换数据源；`packGuides.ts` 瘦身至仅存 prompts。
- **Facet**：经共享组件自动同源，无独立改动。
- **依赖**：`add-agent-spec-sheet` 的引导契约落地后，本 change 是其内容侧收口。
