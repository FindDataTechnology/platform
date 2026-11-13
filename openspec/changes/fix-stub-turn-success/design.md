## Context

- 结算的唯一入口是 `shapeTurnOutcome()`（`server/fleet-events.js`）：它从 outcome 里读 `ok / interrupted / skipped / usage / detail / hollow`，产出 `status`。现有空壳护栏是 `hollowOk = ok && outcome.hollow === true && !usage && !hasAttribution` —— 触发条件要求 **usage 完全缺席**。
- 但生产上抓到的桩回合**带 usage**（输出恰好 128 tokens），所以护栏不动作。24h 统计：`usage_output = 128` 共 67 条 / 248 条有 usage 的回合（27%），**全部 status=ok**，其中 62 条 `model=null`。
- 抽样 `trace.db`：部分桩回合**零事件**（无 assistant/message、无 tool/result），即 collector 什么都没看到，行却记 ok；另一部分输入 131k–168k（贴着/超过声明窗口 128k），输出同样 128。
- `usage` 的细分字段由 `normalizeUsage()` 归一（`input/output/cacheReadTokens/…`），所以"输出多少"与"有没有工具调用"在结算面都可得：`toolBlocks.length` 与 `reported` 已在 outcome 上。

## Goals / Non-Goals

**Goals**
- 让"输出一个桩就算完成"无法通过结算（这正是空壳护栏原本的意图，只是判据缺口）。
- `windowFull` / `outputTokens` 进 detail，使"窗口塞满型"与"从未真跑型"在数据上可分。

**Non-Goals**
- 不去解释上游为什么返回 128 tokens（那是 provider 侧行为；本 change 只做诚实结算）。
- 不改 `contextBudget` 的既有契约（无 usage → 不下结论）。
- 不动 `skipped` 的两源语义。

## Decisions

**D1. 判据放结算层，不放在 collector。**
理由：collector 只知道"看见了什么"，不知道"这算不算完成"；结算层已有 `hollow` 与 `reported` 两个事实，判据集中在一处才可测。
备选：在 collector 里发现桩就直接 reject —— 否决，那会把观测事实变成执行失败，且拿不到跨 provider 的统一判据。

**D2. 四项同时成立才判桩（输出≤阈值 ∧ 无文本 ∧ 无工具调用 ∧ 无报数）。**
理由：误伤面最小。只调一次 `report_status` 的正常短回合有工具调用+报数，不受影响。
备选：只看"输出≤128" —— 否决，会把短回答的合法回合判死。

**D3. 桩回合结算为 `interrupted` 而不是 `failed`。**
理由：`interrupted` 的语义是"这一轮没真正运行"（可重跑、不推进在场、不进失败率），与桩回合的事实一致；`failed` 会把它混进失败率与重跑面（与 4.3「耗尽即 skip」同一条理由）。

**D4. `windowFull` 只做观测。**
输入 ≥ 窗口 95% 时记 detail，但**不据此判失败**——5.3 的数据显示窗口被塞满的回合有成功也有桩，结论要由 D2 的四项给出。

## Risks / Trade-offs

- **误判面**：若存在"本来就不说话、不调工具、只输出极短"的岗位，它会被判 interrupted。这类岗位之前是"看起来一直在成功"，现在会被看见——这是收益，不是回归；但上线后头一窗要按 `detail.stubTurn` 抽查若干条，确认它们确实没干活。
- **阈值 128 太紧/太松**：128 是观测到的常量（输出恰好卡在这个数），不是猜的；用常量 `STUB_OUTPUT_TOKENS = 128` 并在 detail 记录实测值，后续可依据数据调整。
- **通过率会下降**：这是**修正分母**，不是退步；对外解释要与同时期的其它改动分开（今晚已经滚过 3 片）。

## Migration Plan

无迁移。旧行不改写。回滚 = 还原 `shapeTurnOutcome` 的判据分支（纯结算层，无数据副作用）。

## Open Questions

- 62 条 `model=null` 且零事件的桩回合：usage 从哪来？需要一条完整 `platform/stream` 帧来定（本 change 只保证它不再记 ok，不解释来源）。
- 输出恰好 128 是否等于某个 `maxTokens` 下限被上游截断？未证，属 provider 侧。
