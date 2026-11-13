# Design: harden-web-design-foundation

## Context

动机与裁决见 `proposal.md`（Why）。设计层需要交代的两条现网事实：

1. **DESIGN.md 不是缺色，是色没人用**。`colors.success/warning/destructive` 已带 oklch 值成文，但 25 页里的胶囊、计量条、错误面全在各自即兴发挥（青、紫、teal、traffic-light 各一套）。所以本单的主工作量是「对齐 + 供给 + 设门」，不是发明。
2. **现有 `ui/dialog.tsx` 是全仓交互质量的孤例标杆**（focus trap + Esc + focus-restore + `aria-modal`），新原语的行为契约一律以它的水准为基线抄齐，不另定标准。

约束：React 19 + Tailwind v4 + 五语 locale 门 + 浏览器/桌面同一代码；web 侧无 vitest/testing-library，UI 行为真闸历来是 Playwright e2e 与真机走查。

## Goals / Non-Goals

- **Goals**：地基可被 ②③ 直接 import；色彩三层纪律机器可查（lint 棘轮）；DESIGN.md/PRODUCT.md 与代码互证。
- **Non-Goals**：本单不证明「页面更好看」——那需要 ②③ 的消费才算数；不引入新运行时依赖（无 radix 无 shadcn CLI 拉包，手搓对齐现有 dialog.tsx 风格）；不改任何路由。

## Decisions

### D1 · Token 落点：Tailwind v4 `@theme` 扩 `styles/` 根文件，不建新主题包
现有色变量全在 `web/src/styles/`（globals.css 链）内以 `light-dark()` 成对声明，暗亮两态零改。**新增**：状态钉扎别名 `--status-running`（=success）、`--status-paused`（=muted-foreground）、`--status-failed`（=destructive）、`--status-waiting`（=warning）——组件只准消费这四个语义名与 `primary`，不准直接消费色值；序列色阶 `--series-1..4` 从 primary 同 hue 派生、等明度阶梯（多系列计量唯一合法色源）。
**备选**：独立 tokens.json + 构建期注入——否，多一层构建面而 Tailwind v4 `@theme` 本身就是单源。

### D2 · 灯纪律的可查边界（lint 规则集 V1）
design-lint 扫 `pages/**` 与 `components/**`（`components/ui/` 豁免），规则五条：
`hex-color`（`#[0-9a-fA-F]{3,8}`）、`raw-rgba`、`tw-arbitrary-color`（`(\b(bg|text|border|ring|fill|stroke)-\[#[^\]]+\]|-\[(?:oklch|hsl)\([^]]*\)` 类任意值色）、`side-tab-border`（卡片/列表条目类元素上的 `border-l-[2-9]`）、`window-confirm`（`window\.confirm(` 与裸 `confirm(`）。
**备选**：stylelint 或 ESLint plugin——否，仓库 UI 面零 stylelint 建制、biome 无对应插件，node 正则扫源码 + JSON 基线 60 行内可写完可测试，且 `node --test` glob 现成。

### D3 · 棘轮基线的粒度 = `file + rule`，不是 `file + line`
基线 `scripts/design-lint-baseline.json` 记「该文件该类规则允许 N 处」。行号会随任何编辑漂移；计数式基线让 ②③ 迁移每删一类违规数字自动收紧，且不误伤「只改了别处」的 diff。违规判定在 `--changed` 模式取 git diff 文件集与基线对撞：变更文件出现基线之外的新违规即 fail。合入后一次性把现存全部违规落基线（预期 ~40 文件），此后只降不升。
**先例**：星研 `ai_readable_check.py --changed` 门，同一哲学。

### D4 · 原语 API 契约（供 specs 阶段成文）
- `PageShell`：`{ title, subtitle?, actions?, filters?, children }`——标题恒为视口第一读点（治「筛选条压页头」），actions 右锚一行。
- `StatusPill`：`{ status: 'running'|'paused'|'failed'|'waiting'|'neutral', label }`——色从 D1 语义名来，label 必传（色永不单独表意）。
- `Tabs`：`role=tablist` + ArrowLeft/Right + Home/End；现有三套（AgentsPage/HelpDialog/FleetsPage 手搓）即迁移目标。
- `Toast v2`：队列制（max 3 折叠）、`{ severity, title, description?, action?, ttl }`，success 3s、error 8s 且带关闭钮；全局容器在 App.tsx 挂点一次（本单只交付组件与容器，页面接线属 ③）。
- `ConfirmDialog`：复用 `ui/dialog.tsx` 的 trap/restore；`variant: 'default'|'danger'`（danger 主钮走 destructive），焦点默认落**取消**。
- `StatesKit`：`Skeleton{shape}`（与消费组件同形占位块，替代整页空白）；`EmptyState{title, hint?, action?}`（空态必给下一步）；`ErrorState{message, onRetry}`。文案全 props，组件零硬编码串。
- `Card`/`Select`/`Tooltip`：最小 API（Card=表面+可选标题槽；Select 走原生 `<select>` 样式化而非 combobox——a11y 免费，23 处原生 select 平移即得；Tooltip 延迟 300ms、焦点可见触发，替代裸 `title=`）。

### D5 · 测试策略 = 纯函数进 `node --test`，UI 行为验证顺延到 ② 首个消费页
web 无组件测试基建；为 9 个原语建 vitest 是本单不成比例的扩张。**本单可测面**：design-lint 的扫描/基线/棘轮判据（fixture 目录直接喂 `node --test`）、toast 队列 reducer、状态钉扎映射（status→token 名）等纯逻辑。**UI 行为契约**（tab 键盘序、confirm 焦点落位、skeleton 形似度）以 ② 各页 e2e fast 首跑为验收场——② 的 specs 会把这条写进走查判据。**备选**：Storybook dev-only 路由——否，新增可达面即新增攻击面与 parity 负担。

### D6 · PRODUCT.md 刷新口径
`impeccable context` 现读到的 PRODUCT.md 仍是「Platform / fd-craw-private」旧口径（无 fleets/studio/zhiyu/marketplace，Surfaces 清单缺 6 条路由）。按 impeccable init 的五节结构重写而非追加，并把「一盏蓝灯」教义升级成 D1 的三层词汇（灯/状态/序列），使 DESIGN.md 的 overview 与词汇表互证。
**风险自觉**：PRODUCT.md 是 impeccable 每次出片的必读上下文，改它=改未来所有 change 的地基口径，故刷新文案在本单 diff 内单独成节供审。

## Risks / Trade-offs

- **[基线一次落 40 文件 ≈ 合法化现存债务]** → 棘轮语义写明「只降不升」，②③ 的完成判据含基线数字下降行数；基线文件即债务台账，review 可见。
- **[无组件测试先行，② 才暴露行为缺陷]** → D5 把「首个消费者」定为 ② 的 MemoryPage 迁移（最小面），缺陷在 ② 修不回头改 ①；契约已写进 specs 可断言。
- **[Tailwind 任意值色类正则误报合法值（如 `bg-[var(--x)]`）]** → 豁免 `- [var(` 前缀；规则集在 lint 测试 fixture 里正反例各钉一组。
- **[Select 不建 combobox，长列表选择体验受限]** → 接受：23 处现存 select 无一需要 combobox 语义；真需要处（如模型选择器）已有专用件，不并入本单。
- **[PRODUCT.md/DESIGN.md 改动波及并行会话的 impeccable 工作流]** → 文档为纯上下文增益（旧文档本就误导），无 API 面变化；冲突面仅两个 md 文件，按台账律单文件提交。

## Migration Plan

纯增量单：合入即得，无页面开关、无数据迁移。回滚 = revert 原语目录与 lint 脚本，基线文件随之作废，零残留。②③ 按各自 change 单推进；① 合入后 design-lint 棘轮即生效，②③ 的 diff 天然被地基门看护。

## Open Questions

- 序列色阶 `--series-1..4` 的具体阶梯明度（等 L 还是递增 L）留待 ② 的 Resources 重做时用真图表对比定夺——不影响本单规格与任务拆分。
