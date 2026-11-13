# add-offline-pack-authoring — 离线创作/发布 pack（纯本地集群的另一半）

## Why

纯本地集群的供给半边已闭合（`add-offline-pack-supply`：装包可离线），但**创作半边**仍断着：草稿是 cell 本地的（`pack_drafts` 表、零网络），而草稿的唯一出口是 gateway 发布（`POST /api/packs`，需市场可达 + 创作者门）——**断网时一个精心搭好的 pack 无法交付给任何其他机器，甚至无法交付给自己的另一台机器**。本 change 把创作闭环补齐：草稿可导出为 `.yizpack`（复用既有容器与校验），bundle 可反向导入为可编辑草稿；上架市场仍是独立的在线动作，语义不混。

## What Changes

- **草稿导出 bundle（新）**：`POST /api/pack-drafts/:id/export-bundle { manifest }`——编辑器把草稿编译成 manifest（既有组装逻辑不动），服务端用**与安装同一套 `validatePackManifest`** 校验后打成 `.yizpack`（`offline-pack-supply` 容器，sha256 清单/确定性打包全继承）。导出**不是发布**：不产生 packId、不冻结版本、不走创作者门、draft 保持可编辑。
- **bundle → 草稿（新，往返编辑）**：`POST /api/pack-drafts/import-bundle`——把一个 bundle 的 manifest 反向导入为**新的可编辑草稿**（不安装、不物化技能/MCP），作者可在任何机器上继续改、再导出。
- **编辑器动作（新）**：草稿编辑器加「导出安装包」与「从安装包导入草稿」两个动作，与「发布」并列但语义分区明确（导出≠发布）。
- **与既有线的关系**：`offline-pack-supply` 的导出方向只覆盖**已安装**的 pack；本 change 补的是**草稿态**的出口，二者合起来覆盖创作全生命周期（草稿→bundle→装到别机→（可选）在线上架）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-authoring`: 新增「草稿导出 bundle（导出≠发布）」与「bundle → 新草稿（往返编辑）」两条要求——服务端以安装同源校验把关，编辑器动作与发布分区。

## Impact

- **代码**：`server/routes/packs.js`（两个端点）、`server/offline-bundle.js`（复用，容器逻辑零改动）、`web/src/components/packs/PackDraftsView.tsx` + `web/src/lib/packs-api.ts`（动作与 i18n）。
- **契约**：草稿的 `entries → manifest` 组装仍由编辑器负责（单一组装源），服务端只做校验与打包——与发布路径的分工一致（pack-installation 的「服务端取 manifest」纪律不适用于草稿导出，因为草稿本体就在 cell 里）。
- **不改变**：发布流程、创作者门、版本冻结语义、`offline-pack-supply` 的容器格式。
