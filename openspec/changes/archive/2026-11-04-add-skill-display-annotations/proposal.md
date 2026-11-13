# add-skill-display-annotations

## Why

壹座与谦面的 skill 卡显示名全英文且切语言不变。谦面管道（bridge 直通 + 目录投影）11-02 已就绪但上游零数据（finddata 协同单 `add-skill-supply-annotations` 供数据）；壹座侧连通道都没有——`/api/extensions/skills` 不接 locale、无注释投影，chat 注释索引（`getSupplyAnnotationIndex`）只有 servers/tools 两个键；pack 内嵌技能在 `pack-locale` 投影里只覆盖 description 不覆盖 name（与 agents 不对称）。`add-tool-description-enrichment` 明写人读渲染归后续单——本单即其人读侧的 skill 部分。

## What Changes

- **壹座技能卡注释投影**：`GET /api/extensions/skills` 接 `locale` 解析（显式参数 > Accept-Language 首选 > zh）并按四源合并纪律投影供给注释——registry 来源技能走 `metadata.annotations`，文件技能走 paas 仓库注释源的 `skills` 键；无注释条目逐字节不变。
- **chat 注释索引扩 skills 键**：`getSupplyAnnotationIndex(locale)` 产物增 `skills` 键（技能名 → `{label, summary}`），技能调用块同工具块规则渲染通俗标签（原名保留可见）。
- **pack 内嵌技能显示名投影**：`projectManifestForLocale` 的 skills 块增 `name` 投影（读 `i18n.skills[<name>].name`，对齐 agents 写法）；manifest 技能条目的可选 `title`（zh 基轨，契约归 finddata 协同单）随基轨直出。
- **谦面零改动验收面**：谦面 skills 目录直通+投影已就绪，上游数据到位即出中文——作为本单验收对照面，不写代码。
- **运行时契约零改**：skill slug、安装键、闭包闸、锁定/权限一个不动；注释只装饰读面。

## Capabilities

### New Capabilities

（无——全部为 `add-mcp-annotation-overlay` 既有能力的域扩展）

### Modified Capabilities

- `supply-annotation-overlay`: 技能渲染面——壹座扩展页技能卡接 locale 投影、chat 索引扩 `skills` 键；运行时契约零改不变式对 skill 名重申。
- `extension-runtime-management`: skills 运行时管理 API 增 locale 化注释投影（读面增强，管理写面零改）。
- `pack-locale-tracks`: manifest skills 的 `name`/`title` 显示字段纳入投影与 zh 主轨模型。

## Impact

- **paas 仓**：`server/routes/extensions.js`（skills 列表投影）、`extension-store.js`（`getSupplyAnnotationIndex` 扩 skills 键；文件技能注释源装载）、`lib/pack-locale.js`（skills name 投影）、`web`（技能卡渲染 annotation 优先，谦面 skills 目录已就绪零改动）。
- **数据依赖**：finddata 协同单交付 registry 技能 `metadata.annotations` 与 paas 仓库注释源 `skills` 键；本单在数据缺位时全部逐字节回退原文（渐进上产，无硬依赖时序）。
- **协调面**：`add-tool-description-enrichment`（在途）共享注释层读面但不碰 skill 与人读渲染；若两者先后改动 `extension-store.js`，投影函数入口唯一。
