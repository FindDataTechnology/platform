## Context

- 三栏构建器已基本落成：`/studio` 路由 + `AgentStudioPage`（roster/canvas/preview）+ 三桶卡，蓝图生命周期已并入（`fold-blueprint-into-studio` 9/9）；spec-sheet 共享组件与 fork 克隆已归档。
- 门面现状：`AgentsPage` 内含 market tab（内嵌 `PacksPage`）与 Studio 页内链接；MCP/技能柜在 Settings 弹层 `ExtensionsPage`（`settings.sections.mcp`）；`packages/core/src/lib/surfaces.ts` 的 `NAV_SURFACES` 无 packs slug，`AGENTS_TAB_SURFACES = agents/market/apps`。
- 既有重定向先例：`/settings/presets → /agents?tab=agents`、`/settings/packs → /agents?tab=market`（`App.tsx`）；`/mcp`、`/extensions` → `/settings/mcp`（`settings-surface` 管辖，本单不动）。
- 相关在途：`add-agent-studio` 剩 4 任务（4.1/4.2 AI 起草桥、5.3 emit 测试、6.3 六入口冒烟）；`add-skill-self-evolution` 剩真机走查+成本核对，其影响面写的候选区落位（Extensions→技能面）需改挂本单调优区。

## Goals / Non-Goals

**Goals**
- 一级门面：sidebar Agents 入口升格为「智能体构建器」，`/agents` 重组四区，深链可达。
- 零路由破坏：`/agents`、`/studio`、legacy 重定向全部保持解析，query 参数映射到新区柜。
- 纯面重组：组件、端点、数据形状全部复用。

**Non-Goals**
- 不折叠/收编六个既有构建入口（后续单）。
- 不动 Settings 的 MCP/技能区（别名保留，`extension-management-ui`/`settings-surface` 零 delta）。
- 不实现 persona 修订评审（只留占位空态）。
- 不动 MCP/技能内容的 locale 与注释层（`add-mcp-annotation-overlay` 管）。

## Decisions

### D1: slug 复用 `agents`，标签换义，不新建 nav surface
sidebar 入口保持 slug `agents` + 图标 + testid，只换 i18n 标签与面板内容。
- **为什么**：`NAV_SURFACES`/布局解析/用户已保存的工作面定制（per `layout-configuration`）全部按 slug 记账；新增 slug 会让存量用户布局里出现两个智能体类入口或丢定制。`native-lexicon` 的「运行时标识不改，只改用户语言」既律同款。
- **备选**：新建 `builder` slug —— 拒：迁移成本与定制丢失风险，收益只有命名洁癖。

### D2: 四区 = AGENTS_TAB_SURFACES 扩容，不是新路由
构建/供给/我的创作/调优实现为 `/agents` 页内 tab（`surfaces.ts` 的 agents 页 tab 集扩为 `build/supply/creations/tuning`），query 参数（`?tab=supply`）做深链；`/studio` 保持独立路由，构建区提供直达卡。
- **为什么**：与既有 `?tab=market` 深链机制同构，legacy 映射零发明；`/studio` 三栏需要全宽，塞进 tab 内嵌会把 roster/canvas/preview 压扁——直达卡跳转优于内嵌。
- **备选**：构建区内嵌 Studio（拒：视口压缩伤三栏可用性）；新建 `/builder` 路由（拒：断 `/agents` 深链，违背零破坏）。

### D3: 供给三柜 = 三组件换挂点，Settings 别名保留
`McpInstalledView`/`McpMarketView`/技能视图/pack 市场卡按组件原样挂进供给区三柜；Settings 的 `ExtensionsPage` 挂点不动。
- **为什么**：`settings-surface` 已有「Settings sections reuse existing page components unchanged」既律，复用挂点不触其需求；packs 柜先例（已迁出 Settings）证明柜子搬家不破行为。
- **备选**：Settings 区删掉只留 hub —— 拒：多一个 delta、无用户收益。

### D4: 调优区用「占位空态」而非隐藏
persona 修订区未上线时渲染空态说明卡。
- **为什么**：调优区若随能力上线动态隐藏，`add-persona-self-evolution` 归档时还要改本单的渲染条件；空态一次到位，后续只填内容。
- **备选**：特性开关隐藏（拒：多一个开关面）。

### D5: legacy query 映射表集中一处
`?tab=market` → 供给区 pack 市场柜、`?tab=agents` → 我的创作区预设入口，映射写成 `/agents` 页内的一张常量表。
- **为什么**：重定向先例已把 legacy 目标指向 `/agents?tab=*`；区重组后 query 语义变（market 柜现在住供给区），集中映射避免 `App.tsx` 重定向表与页内 tab 各记一份。

## Risks / Trade-offs

- [重组碰 `add-agent-studio` 6.3 冒烟（PacksPage/CustomPresetsPage/BlueprintStudioPage 保持可用）] → 本单吸收该验收：六入口可达性在本单任务里逐条重验，`add-agent-studio` 的 6.3 勾选时引用本单证据。
- [`add-skill-self-evolution` 前端任务写的落位（Extensions→技能面）与本单调优区不一致] → 两单对表：该单实现时直接落调优区（其 spec 未钉位置，无归档冲突）；本单任务含调优区承载联调。
- [四区 tab 深链与工作面定制（layout-configuration）交互未穷尽] → tab 是页内概念不是 nav surface，定制不受影响；e2e 补一条「隐藏 Agents tab 后 /agents 深链仍解析」。
- [词条五语言与 `official-locale-coverage` 的官方资产 en 副轨门] → 构建器是平台 chrome 不是官方资产包，走 `internationalization` 既律（五语言同批录入）即可；词表登记时对表一次。

## Migration Plan

1. 前端单班出片：`surfaces.ts` 扩容 → `App.tsx` 映射表 → `AgentsPage` 重组 → i18n 五语言 → e2e。
2. 灰度无后端依赖：Server 零改动，出片即全量；回滚 = 回滚镜像（无数据迁移）。
3. 词表登记与 i18n 同批提交（docs 与代码同一班，防漂移）。

## Open Questions

- 供给区三柜的默认柜（pack 市场 or MCP 柜）待真机走查定，不影响契约。
- 调优区是否顺带展示 fleet 自迭代提案（`agent-self-iteration`）——属后续增强，本单不做。
