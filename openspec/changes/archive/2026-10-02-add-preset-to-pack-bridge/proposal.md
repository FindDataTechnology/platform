# Proposal: add-preset-to-pack-bridge

## Why

Agent 平台程序（切片 ⓪，背景见 ADR-0010/0011）的第一段断链：用户在 cell 里调好一套自建预设后，想把它部署成 Agent 服务只能去 pack 草稿编辑器把 persona 和引用手工重录一遍——预设刻意无导出（ADR-0003），市场创作面刻意不知道预设的存在，两边没有桥。本change 在两个已有面之间加一个单向转换入口，让「预设 → pack 草稿 → 发布 → 部署为服务」的旅程从重录变成补录。

## What Changes

- **转换动作**：自建预设管理面新增「转为功能集草稿」动作，服务端执行转换并落为一条新 pack 草稿（预设本体不动、不发布——ADR-0003 的 cell-local 边界不变，persona 文本进入的草稿同样存于作者自己的 cell）。
- **转换语义**（可迁移性由服务端解析，结果以标注报告呈现给作者）：
  - persona / name / tags / icon 原样带入草稿；
  - 技能引用：解析为作者自有或部署基线的技能 → 内联进草稿；来自已安装 pack 的技能 → 不迁移（内容非作者所有），标注待替换；
  - MCP 引用：cell 启用名 → registry 市场 `registryName` 解析；解析不到的标注待替换；
  - 角色条目的服务契约默认预置开启（`serving: { protocol: "a2a" }`）——本桥的目的就是部署旅程，作者可关。
- **标注报告**：转换响应携带「已内联 / 待替换」清单，草稿编辑器呈现给作者补齐后再走既有发布流。
- **不动的部分**：发布仍走既有动作与门槛（市场发布需 creators 身份，部署需已发布版本——准入放宽属切片 ③）；草稿落成后与源预设零关联，互不同步。

## Capabilities

### New Capabilities

（无——本change是两个既有能力间的桥，无独立新行为域）

### Modified Capabilities

- `custom-presets`: 「Custom presets stay cell-local」要求增补——预设仍不经市场发布、不可分享，但获得一个单向出口：转为 pack 草稿；管理面新增转换动作。
- `pack-authoring`: 草稿创建多一个来源——从自建预设预填充；新增转换语义要求（可迁移引用内联、不可迁移引用标注待替换、服务契约默认预置）。

## Impact

- **Code**: `server/routes/custom-presets.js`（转换端点）+ 新转换辅助模块（技能引用来源解析、MCP 启用名→registryName 映射）；`gateway/packs.js` 草稿存储复用不动；web `CustomPresetsPage.tsx`（动作入口 + 转换结果跳转）、`PackDraftsView.tsx`（标注报告呈现）；`packs-api.ts` 增转换调用。草稿仍过既有 manifest v2 校验，`lib/pack-manifest.js` 不动。
- **依赖程序**: 切片 ① add-agent-residency、② add-agent-delegation-a2a、③ add-agent-platform-ops 的前置入口；本片独立可验收，不依赖它们。
- **词汇**: 复用 CONTEXT.md 既有术语（自建预设、功能集、服务契约、Agent 服务）；无新术语。

## Non-goals

- 自动发布或一键直达部署（发布仍是作者显式动作）。
- 批量转换、多预设合成一个 pack。
- 反向同步（草稿编辑不回流预设；预设后续修改不自动更新草稿）。
- 覆盖偏好 / 资源集声明的转换（预设没有这些维度，不发明）。
- 私有 pack 可见性（切片 ③）、发布准入放宽（切片 ③）。
