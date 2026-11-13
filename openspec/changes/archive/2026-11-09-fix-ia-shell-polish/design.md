## Context

见 `proposal.md`。这里只记实现约束与实测证据。

实测（2026-11-09，本地 `node server.js` + playwright，`--lang=zh-CN` / `en-US` 各截一张同视图）：

- 家族头：`.text-[11px] .uppercase .tracking-wide`。英文本就是"拉丁小型大写标签"的语言；中文那行读起来是"字糊了 + 字距散开"。
- 设置分组头：`.text-[10px]`，10px 汉字更糟。
- 项目切换器：`.text-[11px]`，默认项目名发虚。
- 折叠：`Sidebar.tsx:733` `collapsed = !isActiveFamily && collapsedFamilies.has(id)`；`toggleFamily` 更新 state 但渲染不改 → 死控件。`toggleAllFamilies` 写满折叠集，渲染仍强展当前家族 → 图标与画面自相矛盾。
- 引导卡：`OnboardingTour.tsx:240` 造出 `onboarding.tour.step` + `onboarding.tour.step1` + `.title`。

## Goals / Non-Goals

**Goals**：中文的微标签与英文同样"像排版"；折叠控件不再有死点击；全局开关与渲染永远一致；首屏不再出现原始 key。

**Non-Goals**：不改主字号体系（正文 13/14px 不动）；不重做导航结构（市场页签属于 `unify-material-market`）；不引入新字体包（沿用现有 CJK fallback 栈）；不改动英文视觉。

## Decisions

### D1 微标签按语种分档，不按组件

在 `globals.css` 立一个语义类（`@layer components` 的 `.micro-label`），内部按 `:lang()` 分档：

```
:where(:lang(en)) .micro-label  → font-size 11px; letter-spacing .02em; text-transform uppercase
:where(:lang(zh), :lang(ja))    → font-size 12px; letter-spacing normal; text-transform none
```

`<html lang>` 由 `web/src/i18n/index.ts:36` 维护（`document.documentElement.lang = l`），运行期切语言即生效，无需重载。

- 为什么不是逐处 `text-[12px]`：那会把语种判断散进 4 个组件，下次加一处标签又忘；一个类 + 一条 design-lint 规则才收得住。
- 替代（否）：用 `font-size: clamp()` 随容器缩放——与语种无关，治不了"汉字笔画糊"。

### D2 折叠：把"常驻强展"换成"进入时展开"

状态机三件：

1. 渲染只读 `collapsedFamilies`（用户的显式选择），不叠加"是否活动"。
2. 路由变化时，若**新**家族在折叠集里，则移除它一次（reveal-on-entry）。
3. 折叠的家族若含活动条目，家族头带活动标记（小圆点/前景色），"你在哪"不丢。

全局开关的 `data-collapsed` 与图标只由 `collapsedFamilies ⊇ 可见家族集` 推导。

- 为什么保留 reveal-on-entry：深链（`/tuning`、`/channels`）必须落在可见面上——这是原规格的意图，只是不该用"永不折叠"实现。
- 替代（否）：折叠状态按路由分桶记忆——复杂且不可预测。

### D3 引导卡 key 修法

`t(\`onboarding.tour.step${n}.title\`)` / `.body`，`install-preset` 特例单独取 `onboarding.tour.stepFleet.*`；并把 `visible[step]` 缺失的情况降级为跳过该步而不是渲染 key。

### D4 混排标签

`nav.shortcuts.tools`：中文 `工具`（MCP 作为副标题/tooltip），英文 `Tools`（MCP 同样下移）。规则写进 design-system 新需求，避免下次又造 `A / B` 式标签。

## Risks / Trade-offs

- [CJK 12px 比英文 11px 略大] → 家族头与条目之间层级差变小。缓解：家族头保留 `font-medium` + 低对比色，靠颜色与缩进维持层级，而不是靠"更小的字号"。
- [reveal-on-entry 与"我记得我折叠了"冲突] → 只在**路由跨家族变化**时展开一次；同家族内换条目不动。已写进场景。
- [design-lint 棘轮新增扫描] → 基线按"文件+规则→计数"落盘，只拦改动文件；否则全仓历史硬编码会让门直接红。
- [引导卡特例] → `stepFleet` 是历史命名，若键不存在要降级而不是抛错。

## Migration Plan

1. 先落 `globals.css` 的 `.micro-label` 与 4 处调用点 → 截图对照 zh/en。
2. 再改折叠状态机 + 全局开关 → 跑 `e2e/layout.spec.js`、`nav-persistence.spec.js`。
3. 引导卡 key 修复 + 一条"可见文本不含 `onboarding.`"断言。
4. 混合拍板文案与 5 语词条同步。

回滚：纯前端呈现层，单 commit 可回滚；无数据/协议变更。

## Open Questions

- 家族头的活动标记用小圆点还是仅文字色：先做圆点（8px 实心），走查后再定。
