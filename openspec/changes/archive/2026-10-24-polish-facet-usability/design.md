# polish-facet-usability — Design

## Context

双面共享同一份 `web/src` 源码（facet/web 经 tsconfig `@/* → ../../web/src` 复用壹座组件，facet.css `@source` 声明扫进 Tailwind）。token 底座（`globals.css` light-dark 对、focus-visible ring、AA 对比度脚本门、shiki 双主题、outline-jump-flash）是资产，全部保留。

## Goals / Non-Goals

- Goals：字号/间距/动效收敛成纪律；状态三态齐；i18n 键化补裸文案；落地页图形化；DESIGN.md 真源。
- Non-Goals：换皮、新组件库、新增依赖、registry 控制台、万星侧、向导助手。

## Decisions

### D1 字号阶梯：`text-xs`(12px) 为正文下限，目测值全灭

26 处 `text-[9/10/11]px` 按语义归位：正文/说明 → `text-xs`；徽标/计数等真·微标 → 保留 `text-[10px]` 仅限「非可读信息」白名单（版本号 chip、状态徽章内数字），DESIGN.md 登记该白名单与上限（10px、mono、单行）。不建 CSS 自定义字号 token（Tailwind 语义阶已够——xs/sm/base/lg 与既有组件尺寸系一致），阶梯是**约定**不是新机制。

### D2 间距纪律：以 4px 栅格语义阶为律，禁新增任意值

存量任意值（`mx-[88px]` 等）在走查中逐处归位到语义阶（px/py gap space-*）；允许保留的任意值（数据可视化的精确尺寸如 `w-[240px]` 卡宽）在 DESIGN.md 登记。不引入 spacing scale 生成器——Tailwind 默认阶即纪律。

### D3 动效词汇：三类白名单 + reduced-motion 豁免

只允许：① 状态反馈（骨架 `animate-pulse`、进度）；② 入场（列表 stagger fade-in ≤200ms）；③ 供示（hover/active 色彩与位移 ≤150ms）。全部走 CSS（transition/keyframes），`@media (prefers-reduced-motion: reduce)` 一刀切禁位移与入场动画、保留状态色变。不做弹跳/视差/自定义 easing 库。

### D4 i18n：五语键化，零新增机制

复用既有 i18next 五语集与 `scripts/check-locales.js` parity 门。CurateView/MineView 的 14+ 处中英混排裸文案 → `facetShell.*` / `facetMine.*` / `facetCurate.*` 键。壹座 Store 面已全键化（走查复核，不预期缺口）。**不做**语言集扩充（用户拍板「和壹座一样」= 现五语）。

### D5 落地页流程图升格：结构化布局，非插画

`creator --publish--> market --subscribe--> 壹座` 两条路径改为三节点图形（flex/SVG，节点=卡片、箭头=方向线），文案仍取 `facetIntro.path.*` 键。保持 spec 约束：静态、无 live 数据、事实构建期可验证、CLI 命令单源。不做插画/动效叙事（与「不换皮」一致）。

### D6 双主题层级：证据驱动，仅微调

暗色零色度层级扁平是**假设**，真机走查（暗色下卡片 vs 背景 vs muted 的对比实测）证据成立才调——dark 侧 `--color-card`/`--color-muted` 给 ≤0.01 chroma 的冷蓝倾向。AA 对比度脚本（test-palette-contrast）是硬门，任何调整过它。

### D7 DESIGN.md：约定文档，非代码

`facet/web/DESIGN.md` 记字号阶梯+微标白名单、间距纪律+任意值登记表、动效词汇、状态三态模式（骨架形/空态引导/错误重试标准形）、语气规则（zh/en 平行、数字事实化）。两处消费同一源码，无共享包需求（YAGNI）。

## Risks / Trade-offs

- 字号归位会动 Store 面大量行——靠 e2e data-testid 不变兜底（facade 断言按 testid，不按类名）。
- reduced-motion 一刀切可能砍掉个别有用动效——白名单机制保留状态色变，验收含 RM 模式走查。
- facet/web 无独立 lint/test 面——验收挂靠壹座 CI（facet shell e2e 已在 ci.yml）。

## Open Questions

- 微标白名单的准确边界（走查中按「读不读得出语义」判定，DESIGN.md 落表）。
