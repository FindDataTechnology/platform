# Design: add-tier-promotion-candidates

## Context

tier 阶梯的三处消费方已就位：digest 的 reference 排序（`db.queryReferences` 里 `canonical=2 / stable=1` 加分）、visibility 的 tier 筛选（`http.ts` 的 `tierFilter`）、成果页徽章。三条都依赖 tier 分布，而生产分布是 `draft 2435 / stable 2 / canonical 4`。

机制并不缺。`distill-scheduler.ts` 的 `tagPass` 已经实现：
- `tags_origin === "human"` 时人工标签胜出；
- `tier_origin !== "human"` 且 `draft → stable|canonical` 或 `stable → canonical` 时才动；
- 落定写 `fm.tier = want === "canonical" ? "stable" : want`，注释即「canonical 永仅经人类/信号」。

窄在选材：`db.referencesNeedingTags` 的 SQL 是
`WHERE project=? AND type='reference' AND updated_at>? AND (tags IS NULL OR tags='[]')`。
双重限制——只 reference 页型、且只挑无 tag 的。生产 reference 仅 10 个、9 个已有 tag，于是 `pending.length === 0` 早退，每次 drain 空跑。

另一层错配：`tierPass` 与 `tagPass` 同一个函数，用同一批 items 请求 distiller 的 `/tag`，返回 `{tags, tier}`。也就是说 tier 判断本来就绑在「给无 tag 的 reference 打标」这个动作上——那些页没有，tier 判断就永远不发生。

预算与调度：`distillBudgetUsed(rootKey, day)` / `dailyLimit()` 是 per-owner 日预算；`tagPassSafe` 包了 try/catch，打标失败不污染蒸馏。触发链是 `capture → notifyCapture → drain → distillOne → (finally) tagPassSafe`，`distillNow` 只从测试进（曾因钩子挂错导致生产零打标，已修）。

## Goals / Non-Goals

**Goals**
- 让 L2 页（fact / experience）进入 tier 晋升候选，这是 2435 个 draft 的主体。
- AI 提议落到人可见可批的面，AI 不直接改 tier。
- 复用既有预算门与调度链，不新增调度器。

**Non-Goals**
- 不放松封顶纪律（AI 最高 stable、canonical 仅人／信号、human 位不可覆）——现状正确，保持。
- 不自动接受提议、不做「AI 自证晋级」。
- 不改 tier 取值集合、不改 digest 渲染顺序、不改页型定义。
- 不引入召回计数排序（见 Open Questions）。

## Decisions

### D1 选材：新增独立查询，不改 `referencesNeedingTags`

新增 `promotionCandidates(project, cursor, limit)`：`type IN ('fact','experience','reference') AND tier = 'draft' AND updated_at > cursor`，**不带 tags 条件**。

- **为什么不扩改现有查询**：`referencesNeedingTags` 服务的是「补 tag」这个不同目的，它的 `tags IS NULL OR '[]'` 条件对打标是正确的。混在一起会让「已标过 tag 的页」反复重新打标，白烧 token。
- **为什么用独立 cursor**：`distill_state` 已有 `tag_cursor`。晋升需要自己的 `promotion_cursor`，否则两者的推进互相牵制（打标推进了 cursor，晋升就没得选）。加列是既有模式（`note_cursor`、`tag_cursor` 都是后加的 `ALTER TABLE`，见 `db.ts` 的补偿迁移）。

### D2 提议落「待确认」面，不直接改 tier

提议写入独立存储（页 frontmatter 的 `tier_proposal` 字段 或 独立表），内容 `{proposed_tier, reason, by: "ai", at}`。人的接受动作才真正改 `tier` 并把 `tier_origin` 设为 human。

- **为什么不直接沿用现有「AI 自动晋级到 stable」**：现有 tagPass 在非 human 位上是**直接写** `fm.tier = want`。这在 reference 索引页上可接受（它们本来就是薄索引），但 L2 fact/experience 是蒸馏产物、数量大，直接晋级等于让 AI 单方面决定「什么算稳定知识」。用户选的方向是「AI 提议 + 封顶 stable」，提议需人批。
- **替代方案**：沿用直接写但只限 stable（改动最小）——被否，因为这与「人确认」的语义冲突，且 2435 个页自动晋级会瞬间淹没任何人的判断力。

### D3 复用 `/tag` 契约还是新增 `/promote`

倾向**新增 `/promote` 端点**（distiller 侧），请求 `{scope, items:[{idx,title,summary,current_tier}]}`，返回 `{results:[{idx, suggest_tier, reason}]}`。

- **为什么不在 `/tag` 里加字段**：`/tag` 的语义是「给无 tag 的页产 tags」，混进晋升会让两条车道的失败互相牵连（`/tag` 解析问题曾两次导致空结果，已修但说明其脆弱）。分开后 `/tag` 行为逐字节不变。
- **代价**：distiller 侧要加一个 handler、prompt、解析器。可复用 `/tag` 的既有骨架（repair_json 解析、token 记账）。
- **替代方案**：只扩 `/tag` 的 items 来源——被否，语义混淆 + 回归面大。

### D4 忽略后冷却，防重复骚扰

提议被忽略后，该页在 `PROMOTION_IGNORE_COOLDOWN`（建议 14 天）内不再被提议。

- **为什么需要**：AI 会持续认为同一页该晋级；没有冷却就是天天弹同一条，人很快学会无视整个面，通道又变噪音。
- 冷却记录在提议存储里（`ignored_at`），不做额外状态机。

### D5 指标进既有 `/admin/metrics`

在 `metricsSnapshot()` 的 `digest`/`embed`/`distill` 之外新增 `promotion: { candidates, proposed, accepted, ignored }`。

- **为什么不新建观测面**：`/admin/metrics` 已是运维唯一入口（探针也读它）。加一节成本最低。

## Risks / Trade-offs

- **[2435 个 draft 全进候选 → 一次拉爆] → limit + 近期更新排序 + 预算门**。首轮只处理最近更新的 N 条，逐步推进；预算耗尽即停。
- **[token 成本显著上升] → 进同一日预算门**，且晋升 prompt 比蒸馏短（只判 yes/no + 理由），单条成本远低于蒸馏。
- **[提议面变成第二个没人看的地方] → 指标暴露 accepted 计数**。若长期 accepted=0，说明这条通道也是摆设，届时该合并或撤销，而不是再建一个面。
- **[`/promote` 解析再次出问题（`/tag` 有前科）→ 单测钉住解析**，且失败只 warn 不阻塞（沿用 `tagPassSafe` 的姿态）。
- **[改 `distill_state` 加列] → 沿用既有补偿迁移模式**（`columnsOf` + `ALTER TABLE`），幂等，不需 schema 版本号。

## Migration Plan

1. fd-memory 先发：加 `promotion_cursor` 列（幂等）、新增 `promotionCandidates` 查询、`/promote` 调用与提议落库；首轮 limit 取小值（如 20）观察 token 消耗。
2. distiller 侧同步发 `/promote`（新端点，不碰 `/tag`）。
3. paas 后发：成果页/记忆面板展示待确认提议 + 接受/忽略交互 + i18n。
4. 回滚：设 `FD_MEMORY_PROMOTION_ENABLED=0` 关闭提议发放（提议数据保留可读），或直接回滚镜像。既有 tier 行为不受影响。

## Open Questions

- 候选排序用「近期更新」还是「digest 召回次数」？后者更准但需新增召回计数。先用近期更新，观察 accepted 率再决定是否值得加计分。
- 提议面放成果页还是记忆面板？两者都能承载；成果页有 tier 徽章更就近，但记忆面板才是 owner 视角。实施时按 ui 现状定。
