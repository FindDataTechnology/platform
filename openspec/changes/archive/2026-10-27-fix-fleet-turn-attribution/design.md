# fix-fleet-turn-attribution Design

## Context

两条证据链决定形状：

**超时不可归因**：`collectTurn`（cron-runner.js:49）的闭包里，`toolBlocks` 逐个累积 `tool/call`（带 name/args）与 `tool/result`，但超时定时器 reject 时只抛 `new Error("turn timed out")`，闭包状态全丢。同时 fleet-runs trace tap 已按 turnId 把每步 seq/ts/payload 落进 trace.db——**归因数据在采集点本来就在手里，丢的只是出口**。

**熔断缺位**：16 次 model_upstream 落在 30 分钟窗，每轮照常撞墙。而 profile 层**已经是多 provider 形状**：`buildUserProviderEntries()` 每条 route 自带 `baseURL` 与独立 `apiKeyEnv`（key 在 .credentials.yaml），models 列表带 `provider` 归属——只是回合层从不记录「这回合跑在哪条车道上」，熔断无从谈起。

约束（用户 2026-10-26 明示）：LLM_API_KEY 未来不再共享，不同 agent 各配 key/baseURL——"反正这个机制一定会在某个地方完成"。设计必须以**车道（lane）为一等实体**，而非把「cell 单车道」焊进代码。

## Goals / Non-Goals

Goals：timeout 回合可归因（stalled vs 预算耗尽可区分）；车道身份进入回合记录；车道键控熔断 + skipped 语义；上游快速失败降级重试一次。

Non-Goals：不改 worker 槽位（独立 bridge，后续跟进）；不做读时 trace join 作为主机制；不改停机补跑与 failing 档（只复用其口径）；不做 per-agent 车道的**配置面**（那属于 add-agent-config-dims 的后续刀，本 change 只保证机制侧零迁移兼容）。

## Decisions

### D1 — 摘要在采集点落列，不做读时 join

`collectTurn` 的 toolBlocks 补 `at`（call 时刻）与 `resultAt`；超时 reject 前从闭包构建摘要：

- 最后一个**无 result** 的 call → `kind: "stalled"`，`lastTool` + `lastToolWaitedMs`（now - at）；
- 全部 call 都有 result → `kind: "turn_budget_exceeded"`，只记 steps；
- 摘要附着 `err.detail`，经 `runPersonaTurn` → `recordFleetTurnEvent` → `shapeTurnOutcome` 落进 `member_turn_events.detail`（JSON 列）。

**为什么不选 join 做主机制**：`member_turn_events`（双条件滚剪）与 trace.db（独立 retention）保留期互不知晓，join 会**静默 NULL**——查三天前的超时，trace 行已被剪，分不清「没记录」还是「丢了」。摘要列与行原子共生；trace join 降级为可用的深挖路径（traceTurnId 已在行上）。分类（stalled/budget_exceeded）只是读闭包状态，零采集成本。

### D2 — 车道 id = provider 的无密钥指纹

`laneKeyFor(provider) = "lane-" + sha256(`${providerId}|${baseURL}|${apiKey ?? ""}`).slice(0, 16)`。key 材料只进哈希不进日志；`apiKey` 取 providers doc 的 `p.apiKey`（credentialRefsForUserProviders 的同源），无则空串——纯端点指纹亦可分辨车道，轮换密钥不重置熔断（坏的是端点不是钥匙，可接受并在 design 记录）。启动时由 `writeLlmProfile()` 返回的 providers 构建 `ctx.llmLaneByProvider`（providerId → laneId），models 自带 `provider` 归属，回合结束按 `outcome.model` 反查。**未来 per-agent 配置落地时**：解析链（fleetModelFor）的每个候选携带自己的 provider/laneId，本机制的 Map 查表换成链上取值，语义零迁移——这正是「做细」的落点。

### D3 — 熔断按 laneId 键控的注册表（不是单例）

`server/llm-lane.js`：`Map<laneId, {failures: number[], openUntil: number|null}>`。滑动窗判开（`PLATFORM_LLM_BREAKER_THRESHOLD` 默认 5 / `..._WINDOW_MS` 默认 10min），开窗 `..._OPEN_MS` 默认 10min；窗口内任一成功 → 立即关闸清零；`PLATFORM_LLM_BREAKER=0` 总闸。cell 共享单车道时所有回合落到同一 laneId，**自然退化为 cell 级**——不是兼容旧语义，是同一语义的退化特例。进程重启清空可接受：熔断是保护性暂态，重启后窗口重新填满即再开。

### D4 — skipped 是回合的第四种结局

`shapeTurnOutcome` 映射 `outcome.skipped === true` → `status: "skipped"`（errorKind null）；`task-engine.finishExecution` 识别 `result.skipped` → `t.state = "skipped"`（engine 层不再把跳过标成 failed——那会触发 UI 的失败口径）；`failureStreak` 只认 `failed`，skipped 自然不计；lastRun 已在回合开始盖章，presence 照常推进。与停机 missedRounds、failing 档构成同一族口径：**没跑（skipped/missed）≠ 失败（failed）≠ 正常（ok）**。

### D5 — 降级重试：收进候选循环，不放行内补丁

`runPersonaTurn` 的「prompt + collect」段抽为局部函数，外层按解析链候选循环：仅 `model_upstream` 失败、回合启动 <60s（`PLATFORM_LLM_RETRY_FAST_MS` 默认 60s）、还有未试候选时，换下一档重试一次；detail 记 `degradedTo`。超时/工具类失败不重试；候选耗尽如实失败。上游快速失败通常 <10s，重试的双倍预算风险被 60s 闸挡住。

### D6 — 记录与跳过都挂在 runCronJobTurn 缝

pre-round 熔断检查放在 preset/model 归位**之后**（那时才知道 effective model → laneId）；失败/成功记录放在 `recordFleetTurnEvent` 同缝（outcome 已带 model 与 errorKind）。a2a/tool 岗位不查熔断（不走模型车道）。

## Risks / Trade-offs

- [上线即出现 skipped（若现网车道正处故障窗）] → 预期行为：那正是「本来该看见」的状态；台账记录首批。
- [轮换密钥不重置熔断] → 坏的是端点不是钥匙；且窗口 10 分钟自愈，影响可忽略。
- [detail JSON 列无索引] → 归因按行读，不按 detail 查询；需要聚合时走 trace。
- [重试把最热路径的 control flow 改成循环] → 局部函数 + 闸门（上游类 + 60s + 一次）+ 专项单测（重试/不重试/耗尽三案）。
- [skipped 在旧前端显示为红色失败] → 前端同窗更新状态色与文案。

## Migration Plan

`member_turn_events.detail` 走 fleets-db 既有幂等 ALTER（try/catch ADD COLUMN），旧行诚实空缺；无数据迁移。回滚 = 回滚镜像（新列留存无害）。

## Open Questions

（无——两个决策点（⑤⑥）由用户 2026-10-26 拍板方向后定案：摘要列为主 + 车道键控。）
