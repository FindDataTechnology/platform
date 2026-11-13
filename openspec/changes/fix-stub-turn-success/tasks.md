# Tasks — fix-stub-turn-success

## 1. 判据

- [x] 1.1 `STUB_OUTPUT_TOKENS = 128` 常量 + `isStubTurn({outputTokens, hasText, toolCalls, reported})` 纯函数（可单测）
- [x] 1.2 `shapeTurnOutcome` 在 `ok` 且 `isStubTurn(...)` 为真时结算 `interrupted`，`detail` 带 `stubTurn: true` 与四项依据
- [x] 1.3 四项任一不成立时，status/detail 与现状逐字节一致
- [x] 1.4 `windowFull`（输入 ≥ 窗口 95%）只写 detail，不参与结论

## 2. 数据通路

- [x] 2.1 `collectTurn` 的 ok 结算带 `outputTokens`（来自 `normalizeUsage`）与 `contextWindow`
- [x] 2.2 `recordTurnEvent` 把这两项交给 `shapeTurnOutcome`，不新增列（走 detail）

## 3. 测试

- [x] 3.1 桩回合（out=128、无文本、无工具、无报数）→ interrupted + detail.stubTurn
- [x] 3.2 只调一次 `report_status` 的短回合（out≈40）→ 仍 ok（不误伤）
  - 附带：既有 `test-agent-config-dims` 两条预算用例的 fixture 正好是桩形状
    （`{usage:{output:50}}` 无文本），已给它们补上 `text` —— 它们测的是预算算术，
    不该顺带断言「无产出=成功」；那条断言现在归 `test-stub-turn`。
- [x] 3.3 有文本、无工具（out=128）→ 仍 ok
- [x] 3.4 out=129 → 仍 ok（阈值边界）
- [x] 3.5 非舰队回合零扰动；`contextBudget` 契约不变
- [x] 3.6 反证：把四项判据改成「只看 out≤128」→ 3.2 红；去掉 `stubTurn` 标记 → 3.1 红

## 4. 规格

- [x] 4.1 `agent-fleet-core` 回合结果事件要求 + 3 场景（随 proposal 写入 delta）

## 4.5 128 的来源（查证记录，未定论）

- [x] 排除 title 调用：`dsh-base` 的 `session-title-llm` 上限是 **64**（`maxOutputTokens: 64`），不是 128。
- [x] 排除全局截断：24h 输出分布 `==128` **96 条**、`129–255` **10 条**、`256–1k` 119 条、`≥1k` 56 条
      —— 128 是**尖峰**但不是严格上限（确有超过它的），所以不是一道全局 `max_tokens`。
- [ ] 仍未知：为什么这么多回合**恰好**落在 128。平台侧看不到 provider 的响应头，
      要定论需要一条带 `stopReason`/`usage` 原始帧的样本。**不影响判据正确性**：
      桩判据要求四项同时成立，做过实事的回合（有工具/有报数/有文本）不会被判桩。

## 5. 上线与观测

- [ ] 5.1 快照 → GHA → relay → digest → GitOps → ArgoCD → 舱内确认 `stubTurn` 出现在行上
- [ ] 5.2 观测一窗：`detail.stubTurn` 条数与 `windowFull` 条数；抽查 ≥5 条确认它们确实没干活（避免把"合法短回合"判死）
- [ ] 5.3 出「修正后的通过率」对照（同一窗口、剔除桩回合前后），并说明与同时期其它上的片分开
- [ ] 5.4 归档（`openspec validate --strict` 通过后）
