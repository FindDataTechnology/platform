# 谦面 Facet — 设计真源（DESIGN.md）

双面共用的设计契约：独立站（`facet/web/src` 薄壳）与壹座 Store 面（`web/src/components/packs/`）消费同一份 `web/src` 源码与 token（`web/src/styles/globals.css`）。本文是呈现层纪律的单一真源；token 数值仍以 globals.css 为准。

## 1. 字号阶梯

- 正文/说明/提示一律语义阶：`text-xs`(12px) 起步——12px 是可读下限，禁止任何 prose 低于它。
- 徽标/标题按语义阶上行：`text-sm` / `text-base` / `text-lg`。
- **微标白名单**：非 prose 的 mono 单行标签（工具名 chip、版本号、A2A/billing 徽章、天梯数字、分轴计数）允许 `text-[10px] font-mono`。当前清单：
  - `PackDetailDialog`：工具 chip（614）、文件列表（464）、A2A/keyBound 徽章（603/704）、版本 current 徽章
  - `PackDraftsView`：工具选择 chip（624）
  - `PackVersionList`：current 徽章
  - `PackDetailDialog`：示例指令剪贴板「已复制」确认（P2 3.5）；覆盖度「缺项」字段路径清单（P3 4.11，数据驱动 mono 标签）
  - `LineLadder`：中文数字 chip
  - `PackMarketView`：线/领域 chip 计数（overhaul-market-catalog-presentation P1）
- 例外：`SiteMark` 的 `text-[10/12/14px]` 是印章字尺寸（facet-platform spec 明文），非正文。
- 新增微标须登记在此清单；不新增第二个任意值。

## 2. 间距纪律

- 栅格语义阶（Tailwind 默认 4px 系）为律；组件内间距用 `gap-*` / `space-y-*` / `p-*` 语义值。
- 任意值仅限数据驱动尺寸，当前登记：`SiteMark` 印章盒（h-7/8/11）、ladder 行徽（px-2 py-px）、curate 垂类输入宽（w-56）、市场搜索/输入宽沿用既有值。新增任意值须登记。

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
