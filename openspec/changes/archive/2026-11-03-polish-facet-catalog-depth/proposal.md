## Why

谦面 MCP 深度页两处真问题（2026-11-03 生产截图+代码实查）：①五语切换器是半截接线——`McpCatalog.tsx` 两处 fetch（列表 :90、深度 :157）都不带 `?locale=`，数据语言钉死在浏览器 Accept-Language 上，切换器只翻 chrome 不翻数据（zh 浏览器切 EN，注释仍中文）；②布局浪费——193 工具单列全宽卡片纵向直滚（横向浪费 60%+）、`whitespace-pre-wrap` 不 clamp（单卡可吃十几行）、无检索无分组（技能区同页已用 `sm:grid-cols-2` 而工具区单列，同页不一致）。后端 locale 投影已被真机验证（`add-mcp-annotation-overlay` 五语走查全过），缺口纯在前端。

## What Changes

- **切换器驱动数据 locale**：MCP 目录列表与深度页（含 skills 区）所有 fetch 带 `?locale=`（取 `useLanguage().locale`），切换语言时重取数据——chrome 与数据同源同变。
- **深度页布局重排**（impeccable Operate 模式）：工具卡响应式多列网格（1/2/3 列随断点）、description line-clamp+展开、按工具名前缀分组（`alerts_*` 等天然信号，零数据依赖）+ 客户端过滤条、内容列 max-width 收口、卡片密度收紧。
- **wire cell 注释数据缺口**：`fd-wire-cell-*` 三条不在 finddata 23 条交付内（客户实例）——回执补记请 finddata 拍板「补策展 or 接受原文」；本单不改数据，无注释条目保持原文如实渲染。
- **明确 Non-goals**：不改后端 API（locale 投影已可用）；不改注释数据形状；不动列表页信息架构（仅受益于 locale 修复）；不做服务端搜索（客户端过滤足够）。

## Capabilities

### New Capabilities

（无——locale 数据行为已有 `facet-platform` 契约承载，本单是前端兑现）

### Modified Capabilities

- `facet-platform`: 「MCP catalog cards on the facet surface」需求下，目录与深度页的数据面 locale SHALL 跟随界面 locale 选择（而非仅浏览器 Accept-Language）；深度页工具区 SHALL 提供分组/过滤与受约束的行高（长描述折叠可展开），无注释条目原文渲染不变。

## Impact

- **Facet 前端**：`facet/web/src/McpCatalog.tsx`（fetch 带 locale + 重取、工具区网格/分组/过滤/clamp）、五语 i18n 新键（分组标签/展开收起/过滤占位）。
- **无后端改动**：`facet/mcp-catalog.js` 端点已支持 `?locale=`，零改。
- **协调面**：finddata 回执（`docs/mcp-annotation-repo-source-receipt.md`）补「wire cell 注释数据拍板」一节。
- **出片**：facet/web/dist 随镜像 COPY（既有通道），无新文件白名单问题。
