## Why

「智能体 = 角色 + 技能 + 工具」的唯一模型与三栏构建器已基本落成（`define-agent-document` / `add-agent-studio` 11/15），但门面仍是从属位：Studio 藏在「智能体」页内链接里，供给三柜分居两处（pack 市场在 AgentsPage 的 market tab，技能/MCP 柜在 Settings 弹层），且想构建的人不知道「该去哪个页面」。把构建升格为一级门面、供给收拢一区，是把已建成的能力变成产品正门——「壹座智能体构建器」。

## What Changes

- **sidebar 一级入口定名「智能体构建器」**：`nav.agents` 标签五语言改为「智能体构建器 / Agent Builder / …」；入口仍是 `/agents`（slug 复用，避免全链路改链接）。
- **AgentsPage 重组为总门面四区**：① 构建（现 `/studio` 三栏构建器，页面顶区直达）② 供给（pack 市场卡 + 技能柜 + MCP 柜合一，三柜同区可切换）③ 我的创作（pack 草稿/manifest 编辑器 + 自建预设管理）④ 调优（技能候选区 + persona 修订区占位）。
- **路由零破坏**：`/agents` 与 `/studio` 路径不变；Settings 的 MCP/技能区保留为别名入口（复用同组件，`extension-management-ui`/`settings-surface` 需求不动）；legacy 路由（`/mcp`、`/extensions`、`/settings/packs`、`/settings/presets`）重定向目标保持现状不扩表。
- **调优区 v1 承载**：`add-skill-self-evolution` 的技能候选列表/评测报告/接受/驳回入口落位到此；persona 修订区为 `add-persona-self-evolution` 预留（本单只留位，不实现）。
- **明确 Non-goals**：不折叠六个既有构建入口（后续单收编）；不改三桶卡、发射口、AI 起草行为（`add-agent-studio` 管）；不改 MCP/技能数据层与 locale（`add-mcp-annotation-overlay` 管）；不动 `native-lexicon` 既有词表条目（新词条在 hub 能力内声明）；不做可写团队图。
- **非 BREAKING**：数据层、端点、发射口、校验器零改；纯前端面重组 + 重定向更新。

## Capabilities

### New Capabilities

- `agent-builder-hub`: 构建器总门面的行为契约——一级入口与五语言定名（zh 主轨「智能体构建器」）、四区结构与各区内嵌面板的承接关系、供给三柜合一的浏览/安装行为、旧路由重定向链、调优区的承载与占位。

### Modified Capabilities

- `app-navigation`: canonical tab set 的「Agents 智能体」标签升格为「智能体构建器」（五语言），`/agents` 面板语义从「智能体页」改为「构建器总门面四区」；legacy 重定向表零扩容（`/extensions` 等仍指 Settings 区）。

## Impact

- **Web（壹座）**：`web/src/App.tsx` 路由与重定向；`web/src/pages/AgentsPage.tsx` 重组为四区门面；`packages/core/src/lib/surfaces.ts`（NAV_SURFACES 标签、AGENTS_TAB_SURFACES 扩 `supply/creations/tuning` 或等效）；`web/src/components/extensions/` 面板迁入供给区（组件复用，挂点换家）；i18n 五语言 `common.json`（`nav.*`、`agentsPage.*`、新增 hub 命名空间）。
- **Server**：零改动（重定向是前端路由；面板读的既有端点不变）。
- **协调面**：① `add-agent-studio` 6.3「既有入口保持可用」冒烟验收由本单吸收——PacksPage/CustomPresetsPage/蓝图工作面在本单重组后仍可达（经重定向或内嵌）；② `add-skill-self-evolution` 影响面写的「Extensions→技能面增候选区」落位改为本单调优区（两边对表，该单任务保持有效、落位面改挂）；③ 新词条五语言表随本单入 `docs/roadmap-agents-native-teams.md` 词表 v4 附录。
