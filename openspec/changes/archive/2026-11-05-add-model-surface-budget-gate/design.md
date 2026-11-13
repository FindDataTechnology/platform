# add-model-surface-budget-gate Design

## 架构
```
model-surface-budget
  ├── BudgetEngine (server/model-budget.js)
  │   ├── checkBudget(model, tokens) -> { allowed, remaining, tier }
  │   ├── consumeBudget(model, tokens)
  │   └── resetDaily() / resetMonthly()
  ├── BudgetStore (SQLite table: model_budget)
  │   ├── model, tier, used, limit, window_start, window_end
  │   └── index on (model, tier)
  └── IntegrationPoints
      ├── switchModelTo (cron-runner.js)
      ├── fleetModelFor (fleet-reports.js)
      └── runPersonaTurn (cron-runner.js)
```

## 预算分级
| 层级 | 窗口 | 单位 | 默认限额 | 超限动作 |
|------|------|------|----------|----------|
| single | 单次 | tokens | 8192 | 降级链下一跳 |
| daily | 24h | tokens | 1M | 降级链 / 503 |
| monthly | 30d | tokens | 10M | 503 |

## 配置
```env
MODEL_BUDGET_SINGLE=8192
MODEL_BUDGET_DAILY=1000000
MODEL_BUDGET_MONTHLY=10000000
MODEL_BUDGET_ENABLED=true
```

## 降级语义
1. 单次超限 → 走 degrade chain 下一跳（同 fix-fleet-model-drift）
2. 日/月超限 → 直接 503 `budget_exhausted`（不走降级链，防止死循环）
3. 预算耗尽事件写入 `budget_exhausted_log` 表，周报产出
