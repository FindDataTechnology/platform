# 谦面 Facet — 设计真源（DESIGN.md）

双面共用的设计契约：独立站（`facet/web/src` 薄壳）与壹座 Store 面（`web/src/components/packs/`）消费同一份 `web/src` 源码与 token（`web/src/styles/globals.css`）。本文是呈现层纪律的单一真源；token 数值仍以 globals.css 为准。

## 1. 字号阶梯

- 正文/说明/提示一律语义阶：`text-xs`(12px) 起步——12px 是可读下限，禁止任何 prose 低于它。
- 徽标/标题按语义阶上行：`text-sm` / `text-base` / `text-lg`。
- **每页恰好一个 `h1`，就是该视图的任务名**（智能体市场 / MCP 与技能 / 使用指南 / 我的发布 / 内容运营），各节从 `h2` 起、不跳级。此前市场与 MCP **一个标题都没有**、四个 gated 视图的页标题是 `h2`——屏幕阅读器拿到的页面没有根。页标题统一 `text-2xl font-semibold tracking-tight`。
  - **唯一例外：介绍页**。落地页的 `h1` 是首屏主张（「千人千面 —— 智能体素材广场」），不是「介绍」——落地页靠价值主张进门，标题写「介绍」等于什么都没说。它的任务名只出现在入口行。
  - 页面标题与入口名必须**同字**：`我的发布` 曾一面叫「我的智能体」、一面叫「我的发布」，五语全部分裂；现在由 `test-facet-shell-labels.mjs` 逐语种钉住相等。
- **微标白名单**：非 prose 的 mono 单行标签（工具名 chip、版本号、A2A/billing 徽章、天梯数字、分轴计数）允许 `text-[10px] font-mono`。当前清单：
  - `PackDetailDialog`：工具 chip（614）、文件列表（464）、A2A/keyBound 徽章（603/704）、版本 current 徽章
  - `PackDraftsView`：工具选择 chip（624）
  - `PackVersionList`：current 徽章
  - `PackDetailDialog`：示例指令剪贴板「已复制」确认（P2 3.5）；覆盖度「缺项」字段路径清单（P3 4.11，数据驱动 mono 标签）
  - `LineLadder`：中文数字 chip
  - `PackMarketView`：线/领域 chip 计数（overhaul-market-catalog-presentation P1）
  - `CurateView`：覆盖度 `en n/m` 徽章、缺项条数、缺项字段路径 chip（overhaul-facet-shell-ia-and-space D6——全部 mono 标签或数据驱动字段路径，非 prose）。同行的「未归类」徽章是**词**不是数据标签，走 `text-xs`（12px 下限）。
- 例外：`SiteMark` 的 `text-[10/12/14px]` 是印章字尺寸（facet-platform spec 明文），非正文。
- 新增微标须登记在此清单；不新增第二个任意值。
- 反向纪律（本轮撞过）：`text-[11px]` **不是**可用档位——它既低于 prose 下限、又不在微标白名单里。行内元信息（版本/作者/用量）一律 `text-xs`。

## 2. 间距纪律

- 栅格语义阶（Tailwind 默认 4px 系）为律；组件内间距用 `gap-*` / `space-y-*` / `p-*` 语义值。
- 任意值仅限数据驱动尺寸，当前登记：
  - 既有：`SiteMark` 印章盒（h-7/8/11）、ladder 行徽（px-2 py-px）、市场搜索/输入宽沿用既有值、包详情弹窗高 `max-h-[80vh]`。
  - 容器族（overhaul-facet-shell-ia-and-space D1，见 §8）：容器上限 `max-w-[1600px]`、侧栏列宽 `grid-cols-[16rem_minmax(0,1fr)]`（`Container` 分栏与市场左栏共用同一字面串）、吸顶侧栏高 `max-h-[calc(100vh-2rem)]`。
  - 表面族：运营台主列 `grid-cols-[minmax(0,22rem)_minmax(0,1fr)]`（含骨架同款）、运营台列表滚动高 `max-h-[calc(100vh-16rem)]`、介绍页首屏 `grid-cols-[minmax(0,1fr)_minmax(0,30rem)]`、站内导航定义列 `grid-cols-[10rem_minmax(0,1fr)]`、MCP 深度事实表 `grid-cols-[max-content_1fr]`。
  - 已退役：curate 垂类自由文本输入宽（w-56）——该输入随 D6 被词表下拉取代。
  - 新增任意值须登记。

## 3. 动效词汇

三类白名单，全部 CSS：
1. **状态反馈**：`animate-pulse`（骨架）；状态色变（非动画）恒存活。
2. **入场**：`rise-in`（≤200ms，fade+4px 位移）——列表 stagger 可用。市场卡片的 stagger 公式住在 `PackCard` 的 `index` 里（每卡 +20ms、全体封顶 200ms），三形态（featured/画廊/普通）共用同一实现不得各写一份；未传 `index` 即无延迟（非列表宿主）。
3. **供示**：`transition-colors`/`transition-opacity`（≤150ms），hover/active。

`prefers-reduced-motion: reduce` 全局豁免（globals.css 一刀切：动画/过渡时长归零、滚动行为还原），状态色不受影响。禁：弹跳、视差、自定义 easing 库、JS 驱动动画。

## 4. 状态三态（异步数据视图标准形）

每个取数视图必须具备：
- **加载**：结构化骨架（`animate-pulse`，形状匹配加载后布局——卡片列=卡片壳、行列表=行壳），禁裸「加载中…」文字。
- **空**：一句引导文案（指向下一个动作），可带外链。
- **错误**：失败命名 + `common.retry` 重试按钮；局部降级（如 curate 的用量面）用琥珀色降级条并明示「主功能不受影响」。

现状锚点：`PackMarketView`（MarketSkeleton/empty/error+retry）、`MyPacksView`、`PackVersionList`、`McpCatalog`（CardsSkeleton）、`CurateView`（BoardSkeleton）、`MineView`（MineSkeleton）。IntroView 按契约恒静态（无三态）。

## 5. i18n 语气

- 五语：en（真源）/ zh-CN / es / fr / ja；`scripts/check-locales.js` parity 是硬门。
- 禁中英混排裸文案（「加载中… / Loading…」类）；zh 用户只看 zh，en 用户只看 en。
- 事实性文案（CLI 命令、版本号、pack id）单源：代码常量（`cliFacts.ts`）或 API 值，不进 locale 文案。
- `<html lang>` 随 locale 同步（`web/src/i18n/index.ts` 既职）。

## 6. 主题

- token 全 `light-dark()` 对（globals.css）；暗色层级若需微调，chroma ≤0.01 且必须过 `scripts/test-palette-contrast.mjs`（AA 硬门）。
- 品牌色不换：蓝白系（primary hue 250）、印章红（SiteMark SEAL_RED）、琥珀降级/警示，是既定资产。

## 7. 落地页路径图

三节点图形（`PathRow`：节点 chip —边标签→ 节点 chip + 注释行），flex 布局即图形，无 SVG 资产；文案键 `facetIntro.pathGraph.*`（五语）；恒静态、无 live 数据、移动端可换行。

## 8. 容器与表面

一句话：**宽度由表面类型决定，不由页面自己决定**。此前每条路由各写一个 `max-w`（介绍/文档 `3xl` 居中、MCP 深度 `6xl`、列表无上限），同一壳里三种宽度并存——内容页两侧各空约 550px，列表页则把一行文字拉满 1600px。两者的病根相同：没有容器契约。

两种容器表面（`facet/web/src/Container.tsx` 是唯一实现），外加一类不进容器的表面：

| 表面 | 档位 | 用在 | 空间律 |
|---|---|---|---|
| 内容型 | `split` | 介绍、使用指南 | `Rail`(16rem，导航/目录/筛选) + `Measure`(max-w-4xl，居左不居中) |
| 列表型 | `wide` | 智能体市场、MCP 与技能、我的发布、内容运营 | 卡片栅格按 `sm:2 / lg:3 / xl:4` 铺开，行内文字不得横跨整个容器 |
| 工作区 | 满幅（**不进容器**） | 创作台 | 三栏吃满可用宽度，1600px 上限在这里反而是损失；外壳只许留**一层** chrome |

工作区为什么不进容器：容器解决的是「一行文字有多宽」，而三栏编辑器里没有一段连续正文，宽度全给面板与画布。它嵌的是壹座同一份 `AgentStudioPage`，在壹座侧也是满幅——在这里加一次上限，同一个编辑器在两个宿主里就有了两种宽度。

细节纪律：

- 容器上限 `1600px`（`Container` 的 `MAX`）；超过它的像素不再提升可读性，只拉长行宽。
- `Measure` 不居中：居中是旧病的形状——留白在两侧，读者视线没有锚点。
- 列表宿主不自己算列数：`PackMarketView` 接收 `layout="tile"` 与 `filters="rail"`，默认 `row`/`top` 逐像素等于壹座今天的样子；列数公式住在 `listGrid` 一处。
- **列数由条目内信息量决定，不是全站一个数**：市场卡片 `sm:2 / lg:3 / xl:4`；`我的发布` 的作者行止步 `sm:2`——行内还有可展开的版本表与两枚操作按钮，第三列会把嵌套表格挤到读不了。判据是「条目能不能在那一列里读完」，不是「是不是同一个类名」。
- 窄屏（<1024px）侧栏一律折叠到正文上方，页面不得出现横向滚动。
- 骨架屏必须与加载后同形：列数随 `layout` 走（`MarketSkeleton({tiled})`、`BoardSkeleton` 同款两栏）。

## 9. 命名与入口

- 每个模块按"观众在这里做什么"命名，五语同译；禁未译原词、禁内部架构词（`Studio`、`策展`、`作者面` 都已退役）。
- 一名一概念：入口标签、页内标题、文档里的指代必须同字；`我的发布`（我上架的）与壹座 `我的智能体`（我装的）不得混用。
- 入口按观众权重分层：公开 tab 走浏览面；作者面与运营面进账号控件但**深链不失效**（`#/mine`、`#/curate` 照旧可解析）。
- 契约由 `scripts/test-facet-shell-labels.mjs` 守卫（键集、禁未译、zh 无拉丁词、工具名与文档同字）。
