# pack-authoring Specification Delta

## ADDED Requirements

### Requirement: 草稿可导出为离线安装包（导出≠发布）

cell SHALL 提供草稿导出：编辑器把草稿编译成完整 manifest 后提交
`POST /api/pack-drafts/:id/export-bundle { manifest }`，服务端以**与安装同一套
`validatePackManifest`** 校验（规则与数量上限一致，离线不免检），通过后打成
`.yizpack`（`offline-pack-supply` 容器：`bundle.json` + `manifest.json` +
sha256 清单 + 确定性打包）返回。导出 SHALL NOT：产生 packId、递增版本、
走创作者门、物化技能/MCP/agent 行、或把草稿标记为已发布——**导出不是发布**，
草稿保持可编辑，后续在线发布沿用既有「冻结下一版本」语义不受影响。

#### Scenario: 断网导出成功

- **WHEN** 编辑器在市场不可达时对草稿执行导出，manifest 通过校验
- **THEN** 返回一个合法 `.yizpack`（digest 可复算），草稿保持可编辑，无任何 packId/版本产生

#### Scenario: 校验失败不落半包

- **WHEN** 提交的 manifest 触发与安装同源的校验错误（如 serving.protocol 非 a2a）
- **THEN** 返回结构化错误（与同内容安装的报错一致），不产出 bundle

#### Scenario: 导出与发布语义分区

- **WHEN** 用户先后执行导出与发布
- **THEN** 导出只产文件，发布才产生 packId/版本；两者互不改变对方的可执行性

### Requirement: bundle 可反向导入为可编辑草稿

cell SHALL 提供 `POST /api/pack-drafts/import-bundle`：接受一个合法 `.yizpack`
（复用 `offline-pack-supply` 的完整校验：摘要/路径/体积闸），把其 manifest 反向
编译为**新的可编辑草稿**（name/description/tags/entries），SHALL NOT 安装该包、
不物化任何技能或 MCP 引用、不触碰已安装列表。导入的草稿与手工创建的草稿
同等可编辑、可再导出、可（在线时）发布。**round-trip 保证**：导出→导入→再导出
SHALL 产出与首次导出摘要一致的 bundle（manifest 相同 → 容器确定性打包相同）。

#### Scenario: 往返编辑

- **WHEN** 作者把导出的 bundle 导入为草稿、修改后再次导出
- **THEN** 新 bundle 的 manifest 反映修改，且容器摘要随内容确定性变化

#### Scenario: 导入是编辑不是安装

- **WHEN** 一个 bundle 被导入为草稿
- **THEN** 已安装 pack 列表、技能库与 MCP 配置均无变化，仅草稿列表多一条
