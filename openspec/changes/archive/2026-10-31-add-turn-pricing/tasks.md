## 1. 词元门与价目缓存

- [x] 1.1 `lib/sub2api-admin.js` 加 3 只读方法：`readModelPricing(model)`（GET model-pricing?model=X，透传 found/四单价）、`listGroups()`（GET groups，透传 rate_multiplier）、`readUserUsageToday(userId)`（POST dashboard/users-usage，透传 today_actual_cost）。验证：单测（fetchImpl 注入）三形状 + found:false 与错误分支
- [x] 1.2 `server/turn-pricing.js`：模块级缓存（model→单价组+pricingAt）、`pricingFor(model)` 同步读、`refreshTurnPricing(models)` 异步刷（10min 定时 + 未命中补拉）、`estimateTurnCost(usage, rates)` 四分量算式、降级 last-good、词元不可达不抛。验证：单测缓存命中/未命中补拉/降级/无价 NULL
- [x] 1.3 `server.js` 启动预热（dshModels 全模型预拉一轮）+ 定时器挂载（unref）。验证：boot 日志一行 warm-up 记录；无 SUB2API_ADMIN_KEY 时静默降级（degraded）

## 2. 落面

- [x] 2.1 `server/routes/fleets-db.js`：member_turn_events 加 `pricing_at` 列；member_turn_daily 加 `cost_input_usd/cost_output_usd/cost_cache_write_usd/cost_cache_read_usd`（REAL）+ `pricing_at`；upsert 累积估算分量（有价样本才累积）。验证：单测有价/无价混合日的列语义（有价样本口径）
- [x] 2.2 `server/fleet-events.js`：recordTurnEvent 计入 pricing_at + 估算（同步 pricingFor，现场折算，事件行带戳不记钱）。验证：单测估算进日行、turn 行无钱列
- [x] 2.3 读面：deserializeTurnEvent 透出 pricing_at；日行读面（ops 直查即可，不加 API 面）。验证：单测读形状

## 3. 对账与回归

- [x] 3.1 `scripts/reconcile-turn-pricing.mjs`：owner 邮箱+可选日期入参 → 平台 est 合计（该 cell 日行）vs 词元 today_actual_cost → 因子输出 + 30% WARN 线。验证：单测因子算式（fetchImpl 假词元）
- [x] 3.2 既有面回归：计量/舰队事件/park-lane/cron 面全绿 + lint。验证：node --test 相关集零红
- [x] 3.3 真机验收：滚版后自然回合 turn 行带 pricing_at、日行出 cost 列；对账脚本真跑一遍输出因子（aloadtree owner）。验证：证据附 change report
