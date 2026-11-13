## 1. 迁移与写面

- [x] 1.1 `server/routes/fleets-db.js`：member_turn_events additive ALTER 加 14 列（preset_id/preset_source/provider/effort/carrier/carrier_instance/lane_id/depth/wave/usage_cached_input/usage_cache_write/usage_reasoning/queue_wait_ms/spin_up_ms/ttft_ms）+ 索引（carrier+started_at、model+started_at）。验证：旧库开库迁移零红、二次开库幂等（ALTER 吞已存在）
- [x] 1.2 member_turn_daily 建表（键 fleet_id/member_id/carrier/provider/model/day，UNIQUE 组合索引）+ 值列（turns/ok_count/failed_count/skipped_count/usage_input/usage_cached_input/usage_cache_write/usage_reasoning/usage_output/queue_wait_ms_sum/queue_wait_ms_max/ttft_ms_sum/ttft_ms_max/spin_up_ms_sum/spin_up_ms_max/updated_at）+ `INSERT..ON CONFLICT` 原子增量 upsert。验证：单测连发两条事件日行翻倍、不同 carrier 分行
- [x] 1.3 `server/fleet-events.js` recordTurnEvent 落列 + 同缝 upsert + D6 降级（新列 INSERT 失败回退旧形状 INSERT + warn 节流，事件本体永不因计量丢失）。验证：单测模拟列写失败事件仍落库（老形状）

## 2. 采集点

- [x] 2.1 `task-engine.js`：唯一入队点 stamp `t.queuedAt`（进 saveTasks 白名单）；执行体 transient `executionCarrier` 字段 + runExecutionTurn 读传 outcome。验证：单测入队→出队 queue_wait 近 0、手工延迟出队 queue_wait>0
- [x] 2.2 `server/worker-slots.js` runTaskOn 认领时设 executionCarrier={carrier:"worker",instance:worker.id}。验证：test-worker-pool 扩断言事件行 carrier=worker
- [x] 2.3 `server/cron-runner.js`：collectTurn 透传 usage 细分三键 + 记首个 assistant 事件时刻；runPersonaTurn 计算 spin_up（park=0、legacy=switchPresetForJob 返回的 spinMs、无 preset=NULL）——switchPresetForJob 返回形状加 spinMs 字段；a2a 执行器设 carrier=remote。验证：park-lane 单测扩断言 spin_up_ms=0、legacy 用例 spin_up>0；ttft 在 fake 回合可测
- [x] 2.4 `server/fleet-events.js` provider 取值：modeled.landed 的 provider 优先 → ctx.runtimeModel 回落 → NULL。验证：单测三态

## 3. 聚合与回归

- [x] 3.1 明细裁剪与汇总无关性：裁剪后日行原值（单测）。验证：prune 触发后 member_turn_daily 不变
- [x] 3.2 既有面回归：fleet 事件/拍板/报数/ledger 全绿。验证：node --test scripts/test-fleet-*.mjs scripts/test-persona-park-lane.mjs scripts/test-cron-*.mjs 零红
- [x] 3.3 真机验收：滚版后任一自然回合 14 列齐（或诚实 NULL）+ member_turn_daily 当日出对应行 + 计费输入=input+cached+cache_write 三列和可读。验证：pod 内 sqlite 查询证据附 change report
