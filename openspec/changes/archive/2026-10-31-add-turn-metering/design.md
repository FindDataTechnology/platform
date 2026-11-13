# Design: add-turn-metering

> 底稿 `docs/agent-parallel-execution-explore.md` 切片②。上游事实（0.2.0-rc.2 锁步树实证）：
> `TokenUsage`（dsh-llm types.d.ts:160）——`inputTokens` 是**未缓存**输入，`cacheReadTokens`/
> `cacheWriteTokens`/`reasoningTokens` 可选细分，计费输入 = 三者之和。现有 `usage_input` 落的
> 是 inputTokens（未缓存口径）——本 change 的细分列把口径补齐，不改动既有列语义。

## Context

- 写缝唯一：`fleet-events.recordTurnEvent`（server.js 的 `ctx.recordFleetTurnEvent` 包一层）是
  所有成员回合结果事件的唯一入口——计量列在此落，日汇总在此 upsert，不建第二条写路径。
- 入队点唯一：`task-engine.js:412` `t.state = "queued"` 是 run-now 与 cron 到期共用的入队
  （`scheduleExecution`），stamp `t.queuedAt` 一处即全覆盖；`runExecutionTurn` 的
  `startTime` 即出队时刻。
- 任务字段白名单落盘：`saveTasks` 按 whitelist 序列化——`queuedAt` 必须进白名单才能跨重启
  存活；`promptOverride`（切片①前例）刻意不进，carrier 标记同属瞬态（不进白名单）。
- 迁移手法：`server/routes/fleets-db.js` 的 additive ALTER 循环（v110/v111 前例：列已存在
  即吞错继续）；member_turn_daily 新表 `CREATE TABLE IF NOT EXISTS` + 索引。

## Goals / Non-Goals

- Goal：计量列成列可聚合、三段时相可查、日汇总永久、采集全部走既有缝。
- Non-Goal：计钱（词元价目折算与对账=切片③；provider/model/day 维度本片就位）；worker pool
  的开启；a2a 计费归因到 sub2api account（v1 lane_id=模型车道 id 已是事实归因）。

## Decisions

### D1 时相落「派生 ms 列」而非原始时刻列

`queue_wait_ms` / `spin_up_ms` / `ttft_ms` 三列落派生毫秒数；原始时刻不落（`started_at`/
`ended_at` 已有）。跨日聚合只吃 ms 列；绝对时刻溯源由 trace_turn_id 关联 trace.db（既有）。

- 备选被否：落 queued_at/first_token_at 原始列——列数翻倍且聚合仍要现算减法。

### D2 spin_up 的语义边界

- 驻留路径（presetPath=parked）：**0**——这是切片①收益的度量面（重启税→0 的前后对照）。
- legacy 路径：`switchPresetForJob` 实测墙钟耗时（含 waitForIdle？**不含**——waitForIdle
  是队列纪律不是重启税；只计 switch 本身。waitForIdle 的等待已经体现在 queue_wait 语义
  之外，单列会双计）。实现：legacy 分支内 `const t0=Date.now()` 环住 `switchPresetTo`
  调用段（switchPresetForJob 返回后减去 waitForIdle 段？——不行，函数内混合。改为：
  runPersonaTurn 在 legacy 分支记录等待后起点，spin_up = Date.now()-该点，该点在
  switchPresetForJob 返回前无法取——**落法**：给 switchPresetForJob 加返回字段
  `{ ok, spinMs }`（内部环住 switch 调用），park 路径 0，无 preset NULL。
- 无 preset 任务：NULL（没有 persona 获取动作）。

### D3 carrier 标记的传递

`task-engine` 执行体挂 transient 字段 `executionCarrier`（对象级，不落盘）：

- `worker-slots.runTaskOn` → beginExecution 前设 `{carrier:"worker", instance: worker.id}`；
- `runA2aRemoteTurn` 执行路径（cluster 扇出成员/独立 a2a 任务）→ `remote`（instance=entry.url
  host?—— v1 instance NULL，url 已在 catalog 可查）；
- 缺省（主链）→ `cell`。
- runExecutionTurn 读该字段传给 outcome；recordTurnEvent 落列。
- 备选被否：由 targetType/targetKind 推断——worker 判定只有认领方知道，推断会冒充观测。

### D4 usage 细分的透传链

`collectTurn` 的 `usage = ev.data.usage` 已捕获整个 TokenUsage 对象——outcome.usage 顺带透传
`cacheReadTokens/cacheWriteTokens/reasoningTokens`（output/usage 返回处展开三个新键）。
recordTurnEvent 从 `outcome.usage` 取值落列；`usage_input` 既有语义不动（未缓存输入），
日汇总的「计费输入」由 input+cached+cache_write 三列相加（视图/查询侧语义，不加第四列）。

### D5 日汇总 upsert 的并发面

appendTurnEvent 是串行写缝（事件本就逐条 append）；upsert 用 SQLite `INSERT ... ON CONFLICT DO
UPDATE` 原子增量（各列 += 本回合值，counts += 1）——无读改写竞态。键含 carrier/provider/model，
维度组合数 = 岗位×车道×模型，量级极小。UTC day 由 `started_at` 取 `toISOString().slice(0,10)`。

### D6 采集失败的降级形状

计量列/upsert 包在 try/catch：失败 `console.warn` + 内存计数（进程级 warnOnce 节流），
MUST NOT 抛回回合缝（spec：计量失败不阻塞回合）。列写入与事件本体写入**同一 appendTurnEvent**
——列写失败不能让事件本体丢失：SQL 层列与本体同 INSERT，失败即整体失败；此时降级为**不带
新列的旧形状 INSERT**（老列必成）+ 日汇总跳过——保证事件面永不因计量回归。

## Risks / Trade-offs

- [ queuedAt 进白名单后旧任务无此字段 ] → 读侧 NULL 容忍；queue_wait 为 NULL 的行聚合时跳过。
- [ provider 取值点 ] → modeled.landed 的 provider 优先；无归一化任务回落 `ctx.runtimeModel`
  所在 provider；都无则 NULL。归属口径=「实际服务该回合的车道」，与 model 列同源推定，
  不做第二套判定。
- [ 日汇总表多 cell 各自为政 ] → 与 fleets.db 同库（每 cell 一份），跨 cell 聚合是萬星
  console 统计面（既有 S4 决策）的事，本片不越界。
- [ spin_up 语义与切片① detail.presetPath 双轨 ] → presetPath 在 detail（文本事实），
  spin_up 是数值度量；0 即 parked 的充分不必要条件（legacy 也可能 0 耗时）——聚合口径写明。

## Migration Plan

1. 滚版后新回合开始带列；旧行 NULL（additive，读侧容忍）。
2. 验证：真机任一自然回合落列 + member_turn_daily 出现对应日行；明细 prune 不动汇总
   （单测覆盖）。
3. 回滚：镜像回滚即回退；新表留存无害（无数据迁移）。

## Open Questions

- 无阻塞项。UTC day 与「部署本地日」的口径差留给统计面展示层处理（聚合键固定 UTC，
  展示可换算）。
