# add-official-packs-i18n

## Why

`pack-locale-tracks` 的契约与实现（overlay 解析、locale 投影、3:1 比率门、fleet.i18n）都已归档在产，
但**官方资产一行副轨都没填**：12 份在仓官方 manifest/seed（3 官方助手 + 3 官方 pack + 5 团队种子 +
架构师种子）全部只有中文主轨——英文访客在市场与登录墙前看到的官方资产一律回落中文。
路线文档（`docs/roadmap-agents-native-teams.md` 线3a）裁定：多语言是「形态副轨、zh 唯一主轨」，
官方资产是门面，副轨必须先满。

## What Changes

- **内容**：12 份官方资产的显示字段全部填 `i18n.en` 副轨（name/description/notes/guide 三步/
  skills[].description/agents[].name/serving.card 文本）；5 份团队种子另填 `fleet.i18n.en`
  （fleet 名、成员岗名、KPI 槽位标签）。**内容层（技能正文/persona/promptTemplate）按契约不翻**，
  只翻显示面。
- **门**：新增 `scripts/test-official-locale-gate.mjs`（`test:unit` glob 自动纳入）——官方资产的
  en 副轨必须覆盖 zh 主轨声明的每一个显示字段（guide 整组或全无、skill/agent 逐条对齐），
  并禁止 zh 块与非显示键混入 fleet overlay。此门是**防漂移**的：以后改官方资产、漏改副轨即红。
- **不改**：pack-locale-tracks 的解析与校验语义（零代码改动——本案是纯内容 + 防漂移门）、
  zh 主轨文本、技能正文、publish 门。

## Capabilities

### New Capabilities

- `official-locale-coverage`: 在仓官方资产（助手包/官方 pack/团队种子）的 en 副轨覆盖契约与防漂移门。

### Modified Capabilities

- `pack-locale-tracks`: 无语义变化——本案是其覆盖纪律在官方资产上的首次全量落地与门禁化（记录性引用）。

## Impact

- **内容**：`docs/official-packs/*.json` ×3、`packs/*/manifest.json` ×3、`docs/fleet-templates/*.seed.json` ×5、
  `docs/fleet-architect.seed.json`（i18n 块 + fleet.i18n 块）。
- **测试**：新增 `scripts/test-official-locale-gate.mjs`（4 用例：助手包覆盖/官方包覆盖/种子双 overlay/
  zh 与结构键禁入）；既有 5 套相关测试（official-packs-lint、fleet-template-locale、fleet-templates、
  pack-locale、pack-locale-validation）零扰动全绿（73/73 实证）。
- **发布注意**：这些 manifest 的已发布市场版本是 immutable 的——en 副轨随**下一次发版**生效，
  在仓种子是铸造真源、下次铸造生效（与 legacy-pack-rebrand 的发版节奏合班）。
- **不影响**：市场读面 locale 投影（已实现）、安装链、定价、可见性。
