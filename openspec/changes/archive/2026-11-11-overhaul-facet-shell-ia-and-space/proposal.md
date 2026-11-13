## Why

谦面薄壳（`facet/web/src`，7 视图 2154 行）是三件事同时不对：

- **空间**：同一个 `main` 里三种宽度并存——介绍/文档各自 `mx-auto max-w-3xl`（768px）居中，1920 屏两侧各空约 550px；而市场、我的发布、运营台是 `grid gap-3` **单列**（`PackMarketView.tsx:428/465`），横版行卡 `PackCard` 被拉伸到 1600px 宽，承诺句一行跑满全天。同仓其他列表（`AppCenterPage.tsx:287`、`FleetPage.tsx:429`、`TeamsOverviewBoard.tsx:388`）早就是 `sm:grid-cols-2 lg:grid-cols-3`，市场是唯一的离群值。
- **命名**：七个 tab 是一条内部术语带——`Studio` 五语皆未译（`facetShell.tabs.studio`），`策展` 是 curation 的直译（中文语境指美术馆），`智能体`（市场）与 `我的智能体`（我发布的，且与壹座同名概念撞车）与 `MCP 服务`（页内还装着技能目录）三名互相侵蚀。违反 `facet/web/DESIGN.md` §5「禁中英混排裸文案」。
- **交互**：查实的坏点不是审美——创作台里「返回」是**死按钮**（`AgentStudioPage.tsx:689` 跳 `/agents?tab=build`，而 `StudioView.tsx:54` 只挂了 `MemoryRouter` 没有 `<Routes>`，跳不动；同类还有 `:541` `/fleets/:id`、`:604` `/agents?tab=market`）；运营台 `pageSize: 100`（`CurateView.tsx:42`）让第 101 个包在管理面**直接消失**；「垂类」是手打 slug 的自由文本而「领域」是词表 chip，同一件事两种输入法，一行要点三次保存。

这三件事现在一起做，是因为它们共用同一批文件与同一批 e2e 断言：命名改了、tab 少了，布局才谈得上重新分栏；而创作台的死链正是「嵌入一个带路由的页面却不给路由表」这一结构问题的产物，改 IA 时必须一并收口。另有一处 spec/代码漂移必须先修：`facet-platform/spec.md:197` 写着「the shell SHALL add no router dependency」且视图列表**不含 `#/studio`**，而创作台已上产并挂了 `MemoryRouter`——不补 spec，后面所有改动都建在漂移上。

## What Changes

- **命名按动作归一**（七语同步：zh-CN + en/es/fr/ja）：`介绍 / 智能体市场 / MCP 与技能 / 我的发布 / 创作台 / 内容运营 / 使用指南`。`Studio`→`创作台`，`策展`→`内容运营`，`智能体`→`智能体市场`，`我的智能体`→`我的发布`，`MCP 服务`→`MCP 与技能`，`文档`→`使用指南`。
- **IA 收口**：公开 tab 四个（介绍 / 智能体市场 / MCP 与技能 / 使用指南）；登录后新增 `创作台`；`我的发布` 与 `内容运营` 从 tab 行降到头像菜单（`我的发布` 对登录用户、`内容运营` 仅管理员）。`#/mine`、`#/curate` **保留为可用深链**，不做 404。
- **空间重排**：统一容器栅格；市场从单列行卡改为响应式竖版卡片网格（`sm:2 / lg:3 / xl:4`），筛选（搜索、尺寸、垂类、领域）从左上方堆叠改为左侧栏；运营台改主从（左列表 + 右详情，带搜索与分页）；创作台去掉冗余标题条、画布放宽、恢复三栏；使用指南改「侧栏目录 + 正文」两栏。
- **死链收口**：嵌入页的路由调用分两类处理——能在谦面内部映射的映射（「返回」回智能体市场），跨域的改真实外链到壹座（集群/组队），不再在无路由表的 `MemoryRouter` 里假装能跳。
- **文档站内重做**：`#/docs` 增四类读者入口（只想装 / 要发布 / 要接 MCP / 站内导航）+「这个站每页干什么」+ 侧栏目录（含当前节高亮）+ 客户端搜索；「深度指南」从 `github.com/…/blob/main/docs`（国内多不可达）改为站内对应小节，公开仓库链接保留为兜底。
- **运营台补全**：分页/搜索替代 `pageSize: 100` 的硬顶；「垂类」从自由文本改为词表选择；保存改为一次提交一行变更（垂类+领域+精选同一次请求），带批量入口。
- **叶子约束**：`PackCard` / `PackMarketView` 与壹座 Store 共用（`AgentMarketPage.tsx:191`）。新布局以 opt-in 参数引入，**默认值等于今天的行为**，壹座侧零变化。

## Capabilities

### New Capabilities

（无。所有改动都落在既有能力的需求上。）

### Modified Capabilities

- `facet-platform`: 视图与入口结构（`#/studio` 补入视图列表、「四个公开 tab」的场景重写、作者面与运营面从顶层 tab 降为账号菜单入口且深链保留、shell 允许为嵌入面挂局部路由表）；文档视图结构（三节 → 四类读者入口 + 站内导航 + 侧栏目录 + 搜索 + 深度指南不得只存在于站外仓库）；创作台面的诚实边界（哪些跨域入口外链壹座）。
- `supply-studio`: 谦面侧创作台面的端口约定——嵌入时由宿主提供局部路由与跨域外链映射，视图内不得出现指向宿主不存在路由的导航。

## Impact

- `facet/web/src/App.tsx`（tab 定义、账号菜单、容器栅格、`aria-current`）
- `facet/web/src/StudioView.tsx`、`facet/studio.js` 装配面不动（路由注入在 web 侧）
- `facet/web/src/CurateView.tsx`（主从、分页、词表垂类、单次保存）
- `facet/web/src/MineView.tsx`（作「我的发布」入口，深链保留）
- `facet/web/src/DocsView.tsx`、`cliFacts.ts`（侧栏、分诊、站内小节链接）
- `facet/web/src/IntroView.tsx`、`PageFooter.tsx`（两栏、放宽）
- `web/src/components/packs/PackMarketView.tsx`、`PackCard.tsx`（新增 opt-in 呈现参数，默认行为不变）
- `web/src/locales/{zh-CN,en,es,fr,ja}/common.json`（`facetShell.tabs.*`、`facetCurate.*`、`facetDocs.*`、新增账号菜单键；`scripts/check-locales.js` parity 是硬门）
- `facet/web/DESIGN.md`（§1 微标清单、§2 任意值清单按自身纪律登记新增项）
- `e2e/facet-shell.spec.js`（文案断言与 tab 计数；`#/mine`、`#/curate` 深链继续可用）
- 不触碰：市场数据面/API 形状、注册处、发布闸、`facet/studio.js` 的库与闸装配
