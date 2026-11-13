# add-tier-promotion-candidates

## Why

tier 三级阶梯（draft → stable → canonical）落地后，生产 2441 个页面的分布是 **draft 2435 / stable 2 / canonical 4**——99.8% 的内容永远停在草稿层。而 digest 的「canonical 优先」渲染规则、visibility 的 tier 筛选、成果页的 tier 徽章都建立在这条阶梯上，等于**三条功能各自连着一个空水箱**。

根因不是缺机制：AI 提议晋级与「canonical 永仅经人类/信号」的封顶纪律**已经实现**（`distill-scheduler.ts` 的 tagPass 里，`tier_origin === "human"` 优先且 AI 最高只到 stable）。问题是这条通道的**选材范围太窄**：`referencesNeedingTags` 的 SQL 是 `type='reference' AND (tags IS NULL OR tags='[]')`——只覆盖 reference 页型，且只挑还没有 tag 的。生产 reference 共 10 个、其中 9 个已有 tag，于是通道几乎无物可选，每次 drain 都是空跑。

## What Changes

- **tier 晋升提议扩展到 L2（fact / experience）**：这些是蒸馏的真实产出、也是 digest 的主要召回对象，2435 个 draft 绝大多数在此。新增独立的「晋升候选」选材，不受 tag 是否已存在限制（已打过 tag 的页仍可能该晋级）。
- **保持既有封顶纪律不变**：AI 提议最高 stable；canonical 永仅经人类手势或信号；`tier_origin === "human"` 的页不被 AI 覆盖。这三点已是现状，本变更 MUST NOT 放松。
- **提议要人可见可批**：候选不直接改 tier，而是落到一个可读的「待确认」面，让人接受/忽略；AI 一旦直接晋级就违反了「人确认」的语义。
- **频次与预算**：晋升提议进同一打标车道（同一日预算门、同一 debounce），不新增独立调度器。
- **可观测**：`/admin/metrics` 能读到「候选数 / 已提议数 / 被人接受数」，否则又是看不见的通道。

## Capabilities

### New Capabilities

- `memory-tier-promotion`: tier 晋升提议的选材范围、封顶纪律、待确认面与人机分工。

### Modified Capabilities

- `memory-distiller`: 打标车道（tag lane）的选材从「仅 reference 且无 tag」扩展为「reference + L2 页型的晋升候选」，且明确 AI 提议不直接生效。

## Impact

- **fd-memory**：`src/db.ts`（新增晋升候选查询）、`src/distill-scheduler.ts`（tagPass 拆出 promotion pass 或扩展选材）、`src/http.ts`（待确认面的读写）、`src/metrics.ts`（候选/接受计数）、`distiller/`（`/tag` 契约复用或新增 `/promote`）。
- **paas**：成果页 / 记忆面板展示「待确认晋升」并支持接受/忽略（`web/src/pages/ResourcesPage.tsx`、`useResourcesStore`），i18n 五语言。
- **token 成本**：晋升提议要调 LLM 判「这个 fact 是否值得从 draft 升 stable」，属新增 token 消耗，必须进同一 per-owner 日预算门。
- **不受影响**：页型定义、tier 取值集合、digest 渲染顺序、既有 reference 打标行为。

## Open Questions

- 候选筛选是按「近期更新」还是「被 digest 召回次数」排序？后者更接近「有价值」，但需要新增召回计数——建议先用近期更新 + 排除已 stable 以上，够用再加计分。
