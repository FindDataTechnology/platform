## Why

`define-agent-document` 已把「agent = 角色 + 技能 + 工具」立为唯一模型，但创作侧仍是 6 个互不复用的入口（自建预设、pack 编辑器、预设转包、蓝图构造间、4 个聊天内 builder persona、facet manifest 直发），三桶从未在一个面上被同时看见、编辑、校验。结果是：想做一个智能体，用户得先知道「该去哪个页面」；官方智能体也因此只能被订阅，不能被看懂或克隆。

本 change 交付**一个可视化构建器**：让三桶在一张卡上可写、团队在一张图上可读、校验与预览实时可见，并从同一份文档发射到既有生命周期。这是「一个 Studio，四个发射口」的第一个支柱。

## What Changes

- **新增可视化构建器 Agent Studio**（壹座 web 新面）：三栏布局——左名册、中画布、右预览/校验。
  - 单 agent = **三桶卡**（角色 / 技能 / 工具），每个桶可写；团队 = **只读节点图**（复用 `FleetGraph`，成员由三桶卡编辑、编导边只读展示）。
  - 右栏 = 结构预览（三桶规格书）+ 实时校验（既有校验器原文）+ provenance 三轴 + i18n 副轨覆盖状态。
- **AI 起草按钮**：把 4 个聊天内 builder persona 的**工具面**收编为画布里的「AI 起草」动作，产物落成可编辑草稿；AI 只产草稿，人批准（不新增写路径）。
- **发射口 v1**：同一份文档可发射为 **① 自建预设（cell 本地）** 与 **② pack 草稿（→ 市场）**；emit 时**再校验**。团队模板与蓝图发射口由 `fold-blueprint-into-studio` 接入（本 change 不接）。
- **零第二造**：校验走 `validatePackManifest` + `parseFleetTemplate` + 工具面闭包闸；发布/安装走既有端点；不新增内容形状、不新增校验器。
- **明确 Non-goals**：不做可写团队图（v1 只读）；不做实时对话预览（v1 只结构预览，发射后可跳聊天）；不合并蓝图生命周期（`fold-blueprint-into-studio` 负责）；不做克隆/血缘（`add-agent-fork-lineage`）；不迁移 `packGuides.ts`。
- **非 BREAKING**：既有 6 个入口在本 change **保留不动**（Studio 是新增面，后续 change 才收编/折叠）。

## Capabilities

### New Capabilities
- `agent-studio`: 三栏可视化构建器的行为契约——三桶卡可写、团队图只读、AI 起草产草稿、实时校验、结构预览，以及向预设/pack 草稿两个发射口的发射与再校验。

### Modified Capabilities
<!-- 无：本 change 只新增 Studio 面，不改既有预设/pack/蓝图/模板/catalog 的需求。 -->

## Impact

- **Web（壹座）**：新增 Studio 页面/组件与路由；复用 `FleetGraph`、`packs-api`、`presets-api`、`useExtensionsStore`、`AssistantPicker` 的规格数据源。
- **Server**：新增 Studio 所需的组合端点（若既有 draft/preset 端点不足以承载三桶读写，则加薄封装；仍复用既有校验与发布管线）。
- **Code 影响面**：`web/src/pages/`、`web/src/components/`、可能 `server/routes/packs.js` / `custom-presets.js` 的薄扩展；`lib/` 校验器零改。
- **下游**：`fold-blueprint-into-studio`（团队模式 + 蓝图发射口）、`add-agent-fork-lineage`（克隆）、`add-agent-spec-sheet`（规格书共享组件可被 Studio 复用）。
