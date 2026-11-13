# Tasks: harden-web-design-foundation

## 1. 色彩三层纪律 token

- [x] 1.1 在 `web/src/styles/globals.css` 的 `@theme` 内新增状态钉扎四枚（`--color-status-running` = success、`--color-status-paused` = muted-foreground、`--color-status-failed` = destructive、`--color-status-waiting` = warning，以引用既有值的方式声明，不复制 oklch 字面量）与序列色阶四枚（`--color-series-1..4`，灯色同 hue 250、等明度阶梯），并加纪律注释（灯/状态/序列三层与各自独占含义）。验证：`npm run web:build` 编译通过，`grep -c "series" globals.css` 命中四枚，既有页面渲染无回归（暗亮两态各看一眼 chat）。
- [x] 1.2 状态钉扎映射纯函数 `statusToken(status)`（running/paused/failed/waiting/neutral → 语义名）落 `web/src/lib/`，供 StatusPill 与 ②③ 消费。验证：node 侧单测断言五键与未知值回退 neutral。

## 2. 原语套件（`web/src/components/ui/`，风格对齐 dialog.tsx）

- [x] 2.1 `card.tsx`：表面容器（可选标题/操作槽），零硬编码文案。验证：tsc 通过、DESIGN.md card-panel 规格一致（rounded.md/padding）。
- [x] 2.2 `status-pill.tsx`：吃 `status` 枚举 + 必传 `label`（颜色永不单独表意）；样式走 1.1 语义名。验证：单测断言 label 缺位时类型报错或渲染兜底、五枚举各有对应类。
- [x] 2.3 `tabs.tsx`：`role=tablist/tab` + `aria-selected` + ArrowLeft/Right/Home/End 焦点导航；激活内容随选。验证：node 单测覆盖键序纯函数（focusIndex 循环/边界），e2e 行为随批②首消费页验证。
- [x] 2.4 `select.tsx`：原生 `<select>` 的主题化封装（label 外传、选项经 props）。验证：tsc、对照 DESIGN.md input 规格（40px/rounded.md）。
- [x] 2.5 `tooltip.tsx`：hover 300ms 出、焦点可见出、Esc 关；内容经 props。验证：定时器纯逻辑单测。
- [x] 2.6 `toast.tsx` v2：队列 reducer（max 3 堆叠、超出入队、success 3s / error 8s + 手动关闭、可选 action 槽）+ 容器。验证：reducer 单测（入队/折叠/驻留时长/关闭幂等）。
- [x] 2.7 `confirm-dialog.tsx`：包既有 Dialog（复用 trap/Esc/restore），`default|danger` 变体，初始焦点落**取消**，danger 主钮走 destructive。验证：tsc + 焦点落位逻辑单测（focus target 选择器）。
- [x] 2.8 `page-shell.tsx`：`{title, subtitle?, actions?, filters?, children}` 固定层级（标题恒为第一读点，actions 右锚）。验证：DOM 顺序断言（title 前置于 filters）。
- [x] 2.9 `states-kit.tsx`：Skeleton（同形块可配）、EmptyState（title+hint+action 槽）、ErrorState（message+onRetry）；三态文案全 props。验证：tsc、类名断言单测。
- [x] 2.10 Toast v2 容器在 `App.tsx` 根部单点挂载（无消费者即空转，零行为变化）。验证：chat 页加载无新错误、既有旧 Toast 组件不动（③ 才下线）。

## 3. design-lint 棘轮门

- [x] 3.1 `scripts/design-lint.mjs`：五规则扫描器（hex-color / raw-rgba / tw-arbitrary-color（`-[var(` 豁免）/ side-tab-border（border-l-[2-9]）/ native-confirm），pages/**+components/** 扫、ui/ 豁免，输出 file+rule+count；导出纯函数。
- [x] 3.2 `scripts/design-lint-baseline.json`：首航快照存量入账（28 文件：hex 76 / confirm 15 / side-tab 9 / arbitrary 1）。验证：跑扫描器对基线 diff=0。
- [x] 3.3 `scripts/test-design-lint.mjs`：fixture 目录正反例钉三判据——新债即红、存量不误伤、`bg-[var(--color-status-running)]` 豁免；另测 ui/ 豁免与规则计数。验证：`npm run test:unit` 收录且全绿（13/13）。

## 4. 文档刷新

- [x] 4.1 DESIGN.md：新增「Color Discipline: Lamp / Status / Series」词表（状态四别名 + 序列阶）、四条 Named Rules（Speaks Twice / Status Vocabulary / Series Ramp / Ratchet）、原语清单九件 API 契约、Do/Don't 补 side-tab 与 window.confirm 禁令。
- [x] 4.2 PRODUCT.md：按 impeccable init 结构重写——Surfaces 补齐 fleets/studio/zhiyu/apps/memory/machines/resources/boards 等路由，品牌口径改「寻数·壹座（Yizuo）」，约束新增「One foundation, many pages」，原则 2 改「Chat is the door; teams are the work」并新增原则 6。

## 5. 合闸验收

- [x] 5.1 全门绿：`npm run check:locales`（零新串）✓、`npm run web:build` ✓、`web/ npx tsc --noEmit` ✓（vite build 不查类型，已单列此门；当场逮到并修掉 4 个 strict 错）、定向集 100/100 —— 覆盖本单改动面的全部「读 web/src 源码」测试（palette 5 / status-tokens 4 / ui-core 8 / design-lint 13 / agent-fork-lineage / agent-studio / app-center / official-locale-gate / layout-resolution）。**全量 `test:unit` 未取得终判**：套件在 `scripts/test-supervisor-ports.mjs` 单测卡死 38 分钟（在册环境用例——多会话固定端口互卡，与本单无关），已终止；改以定向集取证。
- [x] 5.2 真机一眼：本地实例（DB_PATH 指临时库，不触用户数据）双态四面对照（chat 暗/亮、fleets 亮、settings 暗）对生产旧图——子代理判读四张全部 **no visual regression**（暗态无未主题化元素、对比 6.0:1；唯一既存小债=暗态引导 CTA 3.35:1，非本单引入，记批③）；0 pageerror。
