# add-model-surface-budget-gate Specification

## ADDED Requirements

### Requirement: 模型预算门三级检查

系统 SHALL 在任一模型切换或派发入口执行三级预算检查（单次/日/月），预算数据落在 SQLite `model_budget` 表（model+tier 键），任一级超限 SHALL 阻止本次模型调用或触发降级。

#### Scenario: 单次超限走降级链

- **WHEN** 一次派发回合的预估 token 超过单次上限（`MODEL_BUDGET_SINGLE`）
- **THEN** 抛出 `SingleTurnBudgetExceeded`，回合走既有降级链（同 fix-fleet-model-drift 语义），不直接失败

#### Scenario: 日/月超限直接拒绝

- **WHEN** 日窗口（`MODEL_BUDGET_DAILY`）或月窗口（`MODEL_BUDGET_MONTHLY`）用量已达上限
- **THEN** 返回 `503 budget_exhausted`，不进入降级链（防止死循环），事件记入 `budget_exhausted_log`

### Requirement: 预算消费与窗口重置

系统 SHALL 在真实 token 用量落地（metering 写入）时调用 `BudgetEngine.consumeBudget` 更新三级窗口计数，并 SHALL 在每日 00:00 UTC 重置 daily 窗口、每月 1 号 00:00 UTC 重置 monthly 窗口。

#### Scenario: 真实用量入账

- **WHEN** 一回合的 metering 写入实际 token 数
- **THEN** 对应模型三级窗口的 used 同步累加

#### Scenario: 窗口按时重置

- **WHEN** daily 窗口到期
- **THEN** used 归零、window_start 前移，次回合恢复可用

### Requirement: 超限观测与报表

系统 SHALL 产出日/周预算报表（各模型三级 used/limit/利用率、超限事件统计），超限事件 SHALL 可从 `budget_exhausted_log` 表审计。

#### Scenario: 日报产出

- **WHEN** 每日 01:00 UTC
- **THEN** 产出当日各模型预算利用率报表，超限事件逐条可溯
