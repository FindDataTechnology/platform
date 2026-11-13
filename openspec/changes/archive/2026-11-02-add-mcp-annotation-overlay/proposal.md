## Why

供给内容（MCP server、tool、skill）对普通人不可读：壹座 MCP 卡直接裸显 `server.name` 与 command/args 原文，工具名 `mcp__wire-ops__create_issue` 全链上游原文直通、零翻译零改写，唯一防线是 publicFacing pack 直接删内部 server（dsh-profile「工具名和描述会把内部词汇泄给用户」）。pack manifest 的 `i18n` 覆盖块是全仓唯一成熟双语链，但其显示字段白名单不含 mcpServers；registry `/api/servers` 已有 `display_name`/`description` 字段却无人按 locale 投影；facet 自有目录端点不带 locale。用户裁定：**双向都做**——注释层同时服务人（localized 通俗名/一句话/何时用）与智能体（canonical 精准 brief，运行时消费由 `add-tool-description-enrichment` 承接）。

## What Changes

- **供给注释层（三类对象同构）**：每 MCP server / tool / skill 一份注释——`human`（zh 主轨通俗名+一句话+何时用；en/ja/es/fr 副轨）+ `canonical`（面向智能体的精准 brief，本单只存不注入）。注释真源四处按优先级合并：registry 行 metadata（已有 display_name/description）> 仓库注释源 `market-annotations.json`（2026-11-02 finddata 需求书折入：registry 64KB metadata 上限装不下大工具面条目，DB 行不可评审）> 仓库内供给目录（扩展 `market-catalog.json` 形状）> 上游原文；**读时投影、不改源行**。
- **缺省如实渲染**：无注释的对象照旧渲染上游原文（沿 facet「缺字段如实渲染、不发明」既律）；locale 缺失一律回落 zh，zh 也缺（未注释）回落原文。
- **壹座展示面接入**：MCP 已装卡/市场卡渲染注释（display 名+通俗描述替代裸显 server.name 与 command 原文，原文折叠进高级区）；聊天工具块在注释存在时于原始 tool 名旁渲染 localized 通俗标签（原名永不替换）；三桶规格书工具桶列 server 注释名。
- **pack manifest 覆盖块扩容**：`LOCALE_OVERLAY_KEYS` 增 `mcpServers`（逐条按声明 name 覆盖 description；registryName 等运行时标识不动），沿 `pack-locale-tracks` 既有校验规则。
- **facet 目录接 locale**：`/api/mcp-catalog`、`/api/skills-catalog` 与深度视图接 `?locale=`（同 `pack-locale` 解析优先级），卡片/深度页按 locale 渲染注释。
- **口径记账**：`docs/pack-i18n-requirements.md` §3「技能正文翻译不在范围」由本单显式推翻——范围扩到供给内容的显示层（SKILL.md/persona 正文仍不在本单）。
- **明确 Non-goals**：不做运行时 tool-face 注入（change ③）；不做注释的在线协作编辑台（v1 注释经仓库目录/registry 管理面录入）；不改 custom_skills（owner 自写自读）；不做机翻管线（注释人工策展）。
- **非 BREAKING**：无注释对象行为与今天逐字节一致；运行时契约（registryName、工具面声明、闭包闸）零改。

## Capabilities

### New Capabilities

- `supply-annotation-overlay`: 供给注释层契约——三类对象的注释形状（human 五语言轨 + canonical brief + provenance）、三源合并优先级与读时投影、zh 唯一回落与无注释如实渲染、壹座与 facet 两展示面的接入行为。

### Modified Capabilities

- `pack-locale-tracks`: 显示字段白名单增 `mcpServers[].description`（按声明 name 覆盖），兼容性不变量保持。
- `facet-platform`: MCP 目录卡与 skills 目录的渲染增 locale 投影——按请求 locale 渲染注释，缺回落 zh/原文；深度视图工具注释同规则；只读与如实渲染纪律不变。
- `extension-marketplace`: 新增目录条目按 locale 渲染注释的 ADDED 需求（无注释条目行为不变）。

## Impact

- **Server（壹座）**：`extension-store.js` 合并投影（读时叠加注释，不改 DB 源行）；仓库目录 `market-catalog.json` 形状扩展（human/canonical/locales）；**新增仓库注释源 `market-annotations.json`（根文件）+ 零依赖叶 loader `lib/market-annotations.js` + `registry-bridge.js` `mapServer()` 一处合并（registry DB 压过仓库注释源，桥快照同喂壹座与 facet 两平面）**；`server/routes/extensions.js` 读面透出注释；`server/skills.js` / registry skill 读面同规则。
- **lib**：`lib/pack-manifest.js`（LOCALE_OVERLAY_KEYS 增 mcpServers + 校验规则复用既有 i18n 块逻辑）；`lib/pack-locale.js` 零改（解析优先级复用）。
- **Web（壹座）**：`McpServerCard`、`McpMarketCard`、`ToolBlock`、`AgentSpecSheet` 注释渲染；i18n 五语言（注释来自数据，chrome 文案照常走 bundle）。
- **Facet**：`registry-bridge.js` mapper 透传注释字段、`mcp-catalog.js` 端点接 `?locale=`、facet/web 目录页渲染。
- **Registry（外部）**：`/api/servers` metadata 增注释块（display_name 语义保留，注释块为超集）；无 registry 侧改码时经 metadata JSON 透传。
- **Docs**：`docs/pack-i18n-requirements.md` §3 记口径推翻。
- **出片**：`Dockerfile` 加一行 COPY `market-annotations.json`（沿 `market-catalog.json` 同法）；`dist-opensource/` 白名单同步核查；缺文件 = 空表降级不启动失败。
- **协调面**：`add-agent-builder-hub` 供给区三柜渲染经本单注释增强（两单对表）；`add-tool-description-enrichment` 消费本单 canonical 字段（数据形状在本单一次定稿）。
