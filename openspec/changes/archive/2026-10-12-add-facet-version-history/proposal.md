# Proposal: add-facet-version-history

## Why

谦面市场线 F1.1（`docs/facet-market-roadmap.md`，伞文档 2026-10-12 增补）：诉求 4「packs
介绍充分，历史版本顺利保存」——版本链路的后端早已是事实（`pack_versions` 行级不可变、
`GET /api/packs/:id/versions` 列表与逐版取都在产，作者面 `#/mine` 也有懒加载版本行），
唯独**公共 detail 对外只展示最新版**：匿名访客与内部用户无法看见一个包的演进史，也无法
到达历史版本的 manifest 与技能正文。同时版本之间缺少人能读懂的说明（changelog），升了
什么、为什么升，市场上无处安放。

## What Changes

- **detail 视图版本列表（公共面）**：`PackDetailDialog` 增加按需懒加载的版本历史区——
  每行：版本号、发布时间、发布者、版本说明（有则显示）、该版本 manifest 快照与技能
  正文链接。懒加载 = 版本列表不进 detail 默认载荷（市场线风险#4：不随包体膨胀）。
- **manifest 可选版本说明字段**：`notes`（可选 string，≤500 字），随版本不可变（由
  既有 manifest 不可变语义继承），发布门校验超限拒绝。
- **一键发布确认步可编辑版本说明**：preset→pack 一键流的确认步在 name/description
  之外增加可选 notes 编辑；`#/mine` publish-from-manifest 天然支持（裸 manifest 即字段）。
- **`#/mine` 收敛到共享组件**：作者面版本行改用与公共 detail 相同的版本列表组件
  （建在壹座 `web/src/components/packs/`，谦面壳经 `@/*` 别名同享——单一来源，两面不漂移）。
- **边界（不做）**：不提供旧版本一键安装（非技术用户装旧版是坑，历史版本只读可查）；
  CLI update 是 F2.3；基建深度页/文档面是 F1.2/F1.3。

## Capabilities

### New Capabilities

（无——全部为既有能力的 requirement 修改）

### Modified Capabilities

- `pack-marketplace`: 「Browse, search, and inspect」增版本历史披露（懒加载、匿名可达、
  逐版链接与说明展示）；「Manifest validation and limits」增 `notes` 字段契约（可选、
  ≤500 字、超限拒绝）；「Preset-to-service one-click flow」确认步增可选 notes 编辑。
- `facet-platform`: 「The facet surface carries a creator console」——`#/mine` 版本历史
  改为经共享版本列表组件渲染（与公共 detail 同源，不可漂移）。

## Impact

- **代码**：`web/src/components/packs/PackDetailDialog.tsx`（版本区）、新共享组件
  `web/src/components/packs/PackVersionList.tsx`（命名实施时可调）、
  `web/src/lib/packs-api.ts`（notes 类型）、`gateway/packs.js`（发布门 notes 校验）、
  `facet/web/src/MineView.tsx`（换共享组件）；壹座发布确认步组件加可选输入。
- **API**：无新端点——复用既有 `GET /api/packs/:id/versions` 与 `/:versions/:v`；
  `pack_versions.manifest` JSON 原样携带 notes（存储零迁移）。
- **双壳**：壹座市场与谦面市场共用 `PackMarketView` 树，一处改动两面生效；谦面作者面
  经别名同享共享组件。
- **e2e**：双壳哨兵加版本列表断言（懒加载触发、匿名可达、notes 展示、逐版链接可达）。
