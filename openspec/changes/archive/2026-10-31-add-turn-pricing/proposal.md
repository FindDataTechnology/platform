## Why

底稿 `docs/agent-parallel-execution-explore.md` 切片③：切片②把 token 记到了 (model, provider, day)
粒度，但「谁在花钱、花多少」还差最后一跳——价目。词元（sub2api fork）的价目与真实计费面现成
（`GET /api/v1/admin/channels/model-pricing?model=X` 按 token 单价、`POST /api/v1/admin/dashboard/
users-usage` 的 `today_actual_cost` 是计费真数），平台只缺「读 + 折算 + 对账」。S3/S5 既有决策不变：
**词元永远唯一计费真源，平台估算永不混进计费数字。**

## What Changes

- **`lib/sub2api-admin.js` 加 3 个只读方法**（ADR-0011 唯一门，只增不改）：
  `readModelPricing(model)`（按模型单价：input/output/cache_write/cache_read，per-token）、
  `listGroups()`（组倍率 `rate_multiplier` 可读）、`readUserUsageToday(userId)`（计费真数
  `today_actual_cost`）。
- **价目缓存模块 `server/turn-pricing.js`**：进程内价目表（model → 单价组）+ `pricingFor(model)`
  同步读缓存 + 定时刷新（默认 10min）+ 未命中异步补拉；词元不可达降级 last-good，从未见过的
  模型诚实无价（NULL，不填 0）。`pricing_at` = 价目表抓取时刻（版本戳）。
- **日汇总加计费估算列**：`member_turn_daily` 加 `cost_input_usd / cost_output_usd /
  cost_cache_write_usd / cost_cache_read_usd`（REAL，**回合时刻价**逐回合算入日行——价目天内
  变更不误归因）+ `pricing_at`；turn 行只加 `pricing_at` 戳（**不记钱**，D4a 口径）。
- **对账**：`scripts/reconcile-turn-pricing.mjs`（pod 内运维脚本）——平台该 owner 当日
  `cost_est` 合计 vs 词元 `today_actual_cost`，输出漂移因子（估算/真数）；因子含组倍率与
  订阅折扣的合成效应，v1 不自动校准、如实输出（漂移>30% 告警线）。
- **v1 估算口径**：模型默认单价 ×1.0（组倍率/订阅折扣不进估算）——对账因子把它们显式化，
  留 v1.1 校准；理由：key→组→倍率的链路属计费平面，v1 不越界。

## Capabilities

### New Capabilities

- `agent-turn-pricing`：回合计费的估算与对账面——模型单价经词元管理门读取并进程内缓存（价目
  版本戳 `pricing_at`），日汇总按回合时刻价累积估算成本列，估算与词元计费真数经对账面互相
  校验；估算永不混入计费真数，词元不可达降级 last-good，无价模型诚实 NULL。

### Modified Capabilities

（无——`agent-turn-metering` 的计量列与日汇总结构零变化，本片纯加列与新面。）

## Impact

- **代码**：`lib/sub2api-admin.js`（3 只读方法）；`server/turn-pricing.js`（新模块：缓存+估算）；
  `server/fleet-events.js`（recordTurnEvent 计入 pricing_at 与估算列）；`server/routes/fleets-db.js`
  （两表加列 + upsert 累积）；`server.js`（定价缓存启动预热）。
- **契约**：计量列语义零变化；`pricing_at` NULL=当时无价（诚实），聚合以「有价样本」口径读。
- **测试**：估算算式（四分量）、缓存命中/降级、无价 NULL、日行累积、对账因子算式；
  既有计量/舰队事件面零回归。
- **风险**：价目缺模型（自定义渠道）→ NULL 样本不进估算，对账因子会把缺口显式化；
  reasoning_effort 倍率 v1 不计（倍率表已在价目响应内，v1.1 随组倍率一起校准）。
