## Why

pack/registry 生态今天只对内部供给闭合：pack 的 MCP 引用实际只能落到我们自己运维手工上牌的 registry server，市场发布被收窄在 Logto `creators` 组（我们自己的人）。2026-10-27 产品线裁决（需求书 `docs/fleet-platform-supply-open-requirements.md`）：供给层对外开放——第三方的 MCP server、工具与产能，走同一 anatomy 准入后能被集群引用、被 pack 打包、在市场上架。本单开路：vendor 身份类 + 供方上牌闸 + 市场作者开放。市场交易记与分成账由姊妹单 `add-market-revenue-share` 承担。

## What Changes

- **新增供应商身份类（vendor）**：平台层供应商主体——自助注册（加入 Logto `vendors` 组并落平台档案：主体名称、联系凭据、配额、收益归属）、凭据轨道沿用既有「组决定能力 + 平台表管归属」四闸先例，注册即得、不设人工审核（审核在准入闸与发布门）。
- **新增供方上牌闸**：供应商自有 MCP server 的自助上牌工作流——准入审查（主体+材料）、tool-surface manifest 声明、selfcheck、台账登记、经平台 workflow 代客写入 registry（register + toggle）。registry fork 保持内部使用、不建公开门户；workflow 形状预留未来外部 MCP 接入车道（vendor-hosted 与 platform-hosted 双形）。
- **市场作者开放**：发布身份从「限 `creators` 组」修订为「`creators` 组或注册 vendor」，发布门规则（工具面声明闭包等）对 vendor 一律同轨不降闸；pack manifest 与市场条目承载供应商署名（主体名），不再只有 `author_email`。
- **spec 裁决**：`ecosystem-curation` 的 "No open submission surface" 显式改写为「提交面仅向注册 vendor 开放且过策展审查」，与 `ecosystem-access` 的自助社区身份区分。

## Capabilities

### New Capabilities

- `vendor-identity`: 供应商主体的注册、档案、凭据轨道、配额与收益归属骨架。
- `vendor-server-onboarding`: 供应商 MCP server 经供方上牌闸进 registry 的准入审查、工具面声明、selfcheck 与台账登记。

### Modified Capabilities

- `pack-marketplace`: "Publishing is identity-gated"——发布资格扩至注册 vendor；manifest/条目承载供应商署名。
- `ecosystem-curation`: "No open submission surface"——改写为「公开提交面仅向注册 vendor 开放，且一切材料仍过策展审查」。

## Impact

- **身份/门户**：Logto 组配置（`vendors`）、facet whoami 与组判定（`facet/index.js`、`gateway/packs.js` 发布资格判定 `mayPublish`）、新增 vendor 档案存储与 REST 面。
- **上牌链**：新增 gateway 侧供方工作流路由；registry 交互沿用 `registry-bridge.js`/`registry-groups.json`，registry fork（cheap-8，外部仓）最小改动＝启用 self-serve register 端点的受控通道，受 `registry-lineage` fork 纪律约束。
- **发布门**：`lib/publish-tool-gate.js`、`registry-bridge.js` 工具面闭包校验对 vendor 条目同轨执行；`facet/publish-gate.js` 同名包 409 先例维持。
- **spec 依赖**：归档排序需在 `add-market-revenue-share` 之前（分成账挂 vendor 归属）。
- **明确不在范围**：市场交易记/分成账（`add-market-revenue-share`）；集群主人经营面（`add-fleet-owner-surface`/`add-fleet-owner-iteration`）；L3 垂直构造器产品化（finddata 侧另案）；registryName 发布层豁免与安装层硬拒的语义断层——本单只记观察，不动四闸对外语义。
