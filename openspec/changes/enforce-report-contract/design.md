## Context

- 结算入口 `shapeTurnOutcome()` 已经在手上有 `reported`（本回合是否有**完成**的 `report_status`：`tool/call` 记下、`tool/result` 回来才置真）与 `status`，所以"这个 ok 回合交没交"是**现成事实**，不需要新观测。
- 缺的是"该不该交"：这取决于岗位人设。模板里 34/35 声明了必交报，`wire-fleet-content` 没声明。
- 人设文本是自然语言（`docs/fleet-templates/**/teams/*.json` 的 `personas` 字典），运行时被 `writeLlmProfile` 写进 profile 的 preset 里；目前**没有任何结构化字段**表示"这个岗位要求交报"。
- 既有边界：`skipped`（未执行）与 `interrupted`（没真跑）都不该被判违约；`failed` 同理——交付契约只在"回合成功跑完"时成立。

## Goals / Non-Goals

**Goals**
- 让"跑了但没交付"在数据上可数，且**不改通过率**（不污染失败率与重跑面）。
- 判据来自岗位声明，不是全局开关，也不是逐回合正则。

**Non-Goals**
- 不把 `missingReport` 升级成 `failed`，也不触发自动重跑（重跑一个"跑了但没报"的回合会重复花钱，是否重跑是产品决策）。
- 不改人设文本本身（要补契约应改模板，不是改判据）。
- 不追溯历史行（旧数据无该字段，交付率有起算日）。

## Decisions

**D1. 只加 detail 标注，不改 status。**
理由：这个回合**确实跑完了**（tokens 花了、工具调了），把它记 failed 会让失败率与"可重跑"面失真——这正是 4.3（额度耗尽记 skipped 不记 failed）的同一条逻辑。
备选：改 failed。否决，见上。

**D2. 判定读结构化标记，不读散文。**
在装载人设时（`personas` → profile 的 preset 写入处）同时落 `reportContract: "required" | null`，来源是一次性的**构建期**匹配（正则匹配"必 report_status"），落库后结算只读字段。
备选：每回合正则匹配人设散文。否决——散文会改，判据会漂；且每回合做字符串匹配是无谓成本。

**D3. 契约检查的前提是三态，不是两态。**
```
status === "ok" && contract === "required" && reported !== true  → missingReport: true
```
`failed/interrupted/skipped` 一律不判；`contract` 为 null 一律不判。

**D4. 交付率是一个新读数，不复用通过率。**
`交付率 = (ok ∧ !missingReport) / 全部回合`。通过率保持 `ok / 全部`。两个数并列展示，避免"通过率 50% 但其实只交付了 25%"被读成一个数。

## Risks / Trade-offs

- **"无事可报"岗位会被标违约**：例如巡检无命中。这是**要暴露的**——人设里已写「空结果与失败按四分类如实上报」，所以"无新数据"本身就该报一句。上线后第一窗要抽查若干 `missingReport` 回合，确认它们确实该报。
- **构建期正则的覆盖面**：34/35 能匹配；若模板改用别的措辞（"每轮报告一次"），会漏判 → 漏判是**静默放过**，不会误伤。做法是构建期把未匹配的人设列出来（`reportContract` 为 null 的岗位清单），改动模板时能看见。
- **历史不可比**：交付率从本片上产日起算；之前只有"报数/回合"这种粗口径。

## Migration Plan

无迁移。人设装载处新增一个字段（写 profile 时一并落）；旧 profile 重写一次即可生效。回滚 = 不读该字段。

## Open Questions

- `report_status` 被 flood 门拒绝时算不算交付？（当前 `reportRejected` 已落 detail，但 `reported` 仍为 false）——本 change 先按"未交付"处理，因为下游确实没收到；是否要把"拒绝"单独分类属后续。
- 一个回合多次报数只算一次交付（幂等），这是现状语义，不改。
