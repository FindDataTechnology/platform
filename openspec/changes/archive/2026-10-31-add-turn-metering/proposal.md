## Why

底稿 `docs/agent-parallel-execution-explore.md` 切片②：台账要「记细到能事后审计每次自我迭代值不值」。
现状 `member_turn_events` 只有 18 列（input/output 两个 token 整数 + model + 起止时刻）——并发度
够不够（queue_wait）、还在付多少重启税（spin_up）、缓存命中率（最大的省钱杠杆）、谁付的钱（车道）、
跑在哪种身体上（carrier）全都无处落。切片⑤（carrier 可配）与切片⑥（自迭代提案器）都要拿这些
列当证据源与反馈回路。

## What Changes

- **`member_turn_events` 加列**（additive ALTER，同 v110/v111 手法；聚合字段成列建索引，
  不塞 detail JSON——detail 按行读不按列查）：
  - 身份维度：`preset_id` / `preset_source`（catalog|custom|shipped）、`provider`、`effort`、
    `carrier`（cell|worker|remote）、`carrier_instance`（worker id / pod 名）、`lane_id`
    （v1 的计费归因=模型车道）、`depth` / `wave`（扇出链位与波次）
  - usage 细分：`usage_cached_input` / `usage_cache_write` / `usage_reasoning`——语义对齐上游
    TokenUsage（`inputTokens` 是**未缓存**输入；计费输入 = input+cacheRead+cacheWrite 三列之和）；
    运行时未报则诚实空缺（NULL），绝不填 0
  - 时相三段：`queue_wait_ms`（出队时刻−入队时刻）、`spin_up_ms`（驻留路径=0、legacy 重启路径=
    实测切换耗时、无 preset 任务=NULL）、`ttft_ms`（首 assistant 事件−回合开始）
- **采集点（单缝纪律）**：入队时刻 stamp 在 task-engine 唯一 enqueue 点（`t.state="queued"` 处，
  worker/primary 共用）；执行载体 transient 字段由 slot 认领方写（worker-slots→`worker`、
  a2a 执行器→`remote`、缺省 `cell`）；collectTurn 透传 usage 细分并记首个 assistant 事件时刻；
  fleet-events.recordTurnEvent 同缝写列。
- **日汇总表 `member_turn_daily`**：键（fleet×member×carrier×provider×model×UTC day），
  值（turns/ok/failed/skipped 计数 + 五类 token 合计 + 三段时相 sum/max）——appendTurnEvent
  同缝 upsert，**永久保留**（对齐统计面「每日聚合永久」决策）；明细裁剪（200 行/30 天）
  不影响汇总。
- **价目留白**：本切片不记钱（词元价目折算与对账=切片③），但 provider/model/day 维度已就位，
  ③ 可按 (model, day) 直接对上词元价目。

## Capabilities

### New Capabilities

- `agent-turn-metering`：定时车道回合的细粒度计量面——每回合计量列（身份/usage 细分/时相三段）
  随回合结果事件同缝落列、缺席语义=诚实空缺、计量失败永不阻塞回合；日汇总表永久保留且与明细
  同缝累积。

### Modified Capabilities

（无——agent-fleet-core 既有「成员回合产出回合结果事件」用「至少含」措辞，加列不违约；
新面独立成 capability。）

## Impact

- **代码**：`task-engine.js`（enqueue stamp + transient carrier 字段）；`server/worker-slots.js`
  （认领时写 carrier）；`server/cron-runner.js`（collectTurn usage 细分透传 + 首 token 时刻 +
  spin_up 实测；a2a 执行器写 carrier=remote）；`server/fleet-events.js`（recordTurnEvent 写列）；
  `server/routes/fleets-db.js`（ALTER 加列 + member_turn_daily 建表 + 索引 + upsert）。
- **契约**：`member_turn_events` 既有列与语义零变化（纯加列）；run ledger / 报数 / 拍板面零触碰。
- **测试**：计量列采集（usage 细分/时相三段/缺席 NULL）、rollup 累积与裁剪无关性、
  计量失败回合不失败；既有 fleet 事件面测试零回归。
- **风险**：入队点 stamp 漏路径会让 queue_wait 空缺（宁可空缺不可错值）；provider 取自
  归一化落点（ modeled.landed 的 provider），无归一化任务回落 runtime 当前值。
