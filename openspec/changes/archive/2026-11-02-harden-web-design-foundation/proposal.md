# Proposal: harden-web-design-foundation

## Why

2026-11-02 探索（impeccable 三路评估：检测器源码扫描 + 25 页源码审计 + 生产 14 面视觉评审）定罪：功能在 25 页 / ~40k 行 UI 的尺度上生长，而设计地基停在 chat 时代的 7 个原语（`ui/` 仅 button/dialog/icon/input/label/switch/textarea）。每支 feature-change 都在手搓同一批形状——三套互不相认的 tabs（~22 处 `setTab`）、23 个文件各自原生 `<select>`、17 个文件手抄 `text-lg font-semibold` 页头、5+ 文件各定一套状态胶囊、Toast 单槽 1.6s 无严重度、骨架屏全仓只有 4-5 个文件有——且 DESIGN.md 的「一盏蓝灯」教义没有任何执行机制（检测器在 chat 组件里仍逮到 7 处 `border-l-2` 侧边条 AI 味）。全站 app 级启发式打分 ~20/40：chat/Studio/Machines 3/4 是真为本产品而生，Memory/Apps/Resources/Zhiyu/Agents 2/4 已滑向「任意 SaaS 模板脸」。方差即病因：地基无可继承物，每次出生都自带一套新设计系统。

用户已裁决（2026-11-02）：方案形态 = C 混合三批；教义 = 严格执行一盏蓝灯 + 把 DESIGN.md 已定义的语义色落成全站词表；覆盖面 = web 工作台 + 桌面（同一代码自动覆盖），miniapp 与官网不入。本单为批①，**纯增量地基**——不动任何一行页面代码，与在途 change（agent-builder-hub、teams-hub、knowledge-memory-surface 等）零文件冲突，可立即开工。

## What Changes

- **语义 token 层对齐并显式化**：把 DESIGN.md 已定义、但页面从未使用的 `success`/`warning`/`destructive` 色值收进 `web/src/styles` 的 Tailwind v4 主题变量，发布全站「状态色阶词表」——running/paused/failed/待拍板各钉一色，颜色永不单独表意（必配文字或图标冗余）；蓝灯语义独占（只表「正在干活 / 焦点 / 用户发言 / 每视图唯一主操作」）；多系列计量（Resources/Machines 的进度条）改钉一条主蓝派生的等亮度四级序列色阶 `--series-1..4`，单系列计量一律灯蓝。
- **原语套件（新增 `web/src/components/ui/`，交互纪律对齐现有 dialog.tsx 的 focus-trap/Esc/focus-restore 水准）**：`card`、`status-pill`（吃词表）、`tabs`（统一 `role=tablist` + 方向键）、`select`、`tooltip`（替代裸 `title=`）、`toast-v2`（多槽堆叠队列 + severity + 可选 action，替代单槽 1600ms）、`confirm-dialog`（主题化、危险变体、焦点默认落取消——替代 9 处 `window.confirm` 的先例供给方）、`PageShell`（标题/动作区/筛选区固定层级，治「页头被筛选条压过」）、`StatesKit`（骨架屏 + 有为的空态 + 带重试的错误态三件套）。
- **全部原语零硬编码文案**：文案一律 props 传入，`check:locales` 五语门在本单零增量。
- **design-lint 棘轮门**：新增 `scripts/test-design-lint.mjs`（`node --test`，进现有 `test:unit` 链），扫描 `pages/**` 与 `components/**`（ui/ 自身豁免）的 `#hex`、`rgba(`、Tailwind 任意值色类（`bg-[#…]`/`text-[#…]`）、卡片上的 `border-l-2/3/4`、以及 `window.confirm(` 调用；现存违规入 `scripts/design-lint-baseline.json` 存量基线，**只拦增量**（棘轮式，先例：星研发布线 `ai_readable_check --changed` 门）。
- **文档刷新**：DESIGN.md 同步（色阶词表 + 原语清单 + 灯纪律 + 序列色阶使用条件）；PRODUCT.md 修正——现稿仍是 fd-craw-private「Platform」口径，未写舰队/构建器/智语/市场等主力面，`impeccable context` 已在读旧图。
- **Non-goals（零改动面）**：不迁任何一个页面（迁移=批②③）；不改行为、端点、WS 契约、数据层；不做暗亮双主题重构（沿用现有 `light-dark()` 值）；miniapp 不搭车；官网 Persuade 轨不搭车。**非 BREAKING**。

## Capabilities

### New Capabilities

- `web-design-system`: 设计地基的行为契约——token 集与「一盏蓝灯 + 状态词表 + 序列色阶」三层色彩纪律（含「颜色永不单独表意」冗余律）、原语套件清单及各原语的交互契约（tabs 键盘导航、toast-v2 队列与严重度、confirm 焦点落位与危险变体、StatesKit 三态语义、PageShell 层级）、design-lint 门的规则集/存量基线/棘轮通过判据、原语零硬编码文案律。

### Modified Capabilities

（无——本单纯增量。页面级能力 `memory-portal-ui`/`app-center`/`agent-catalog`/`resource-library-ui`/`zhiyu-room`/`agent-teams-overview`/`settings-surface` 等的迁移改动由批②③各自提案挂账。）

## Impact

- **web（壹座）**：新增 `web/src/components/ui/*` 约 9 个原语文件；`web/src/styles` 主题变量增补；`scripts/test-design-lint.mjs` + `scripts/design-lint-baseline.json`；`package.json` 无新脚本面（lint 进现有 `test:unit` glob）。
- **Server / API / WS / 数据库**：零改动。
- **桌面**：同一 web 代码自动覆盖；桌面 parity 约束天然满足。
- **质量门**：`check:locales` 零新增串（props 注入纪律）；biome 常规；新增 design-lint 棘轮。
- **排期协调**：本单只碰 ui/、styles/、scripts/、两份根文档——与 15 支在途 change 零交集，可先落；②③ 开工的前置信号即本单合入。批②（六面门面重做）、批③（全页三态/确认/反馈/a11y 统一）各自已立 change 单（`modernize-lagging-surfaces`、`unify-operate-states`），其页面改造全部继承本单原语，不再手搓。
