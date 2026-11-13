# add-model-surface-budget-gate Proposal

## 背景
宪章 §7 质量门第二刀：model-surface 预算门。docs 门已落（8276ea0e），预算门缺立案。
- 背景：fleet-model-drift 复盘显示，child 模型态被 out-of-band 切走，导致 drift 复发（14:00 turn 185 为反例：header=deepseek 证明断言落地，但需预算门防止超支）。
- 目标：在 model-surface 层面引入预算门，单次/日/月三级预算，超支自动降级或拒绝。

## 方案
1. **预算三级**：单次上限（tokens）、日上限、月上限；可配置（env / config）。
2. **执行点**：`switchModelTo` / `fleetModelFor` / `runPersonaTurn` 入口前置检查。
3. **降级策略**：超预算 → 自动降级到 fallbackModel / 降级链下一跳；无可用则返回 503 `budget_exhausted`。
4. **观测**：metering 写入 `model_surface_budget` 表，日报/周报自动产出。

## 范围
- 新增 `server/model-budget.js`（预算引擎）
- `cron-runner.js` / `fleet-reports.js` / `fleet-runs.js` 集成
- `docs/model-surface-budget.md` 设计文档
- 单测 + e2e（预算耗尽降级、恢复、跨月重置）

## 验收
- 单测：预算耗尽→降级链→503 落地
- e2e：连续派发触发日上限→自动降级→次日凌晨重置恢复
- 生产：七日观察期，零误触发，零漏报
