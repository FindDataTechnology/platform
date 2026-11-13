# fix-fleet-turn-attribution Tasks

## 1. 数据面：detail 列

- [x] 1.1 `server/routes/fleets-db.js`：member_turn_events 幂等 ALTER 增 `detail TEXT`；appendTurnEvent 写入、deserializeTurnEvent/turns API 透传（JSON 安全解析，坏值诚实 null）；验证：单测断言 detail 落行与读回

## 2. 超时归因

- [x] 2.1 `server/cron-runner.js` `collectTurn`：toolBlocks 增 `at`/`resultAt` 时间戳；超时 reject 前构建摘要（stalled：最后无 result 的 call + 等待时长；turn_budget_exceeded：全有 result 仅步数）附着 `err.detail`；成功路径零变化；验证：单测两形态 + 无工具史诚实空缺
- [x] 2.2 `server/fleet-events.js`：`shapeTurnOutcome` 透传 `outcome.detail`（含 degradedTo/laneId 合成）；验证：单测断言 detail 落 shape

## 3. 车道熔断

- [x] 3.1 新建 `server/llm-lane.js`：`laneKeyFor(provider)`（sha256 前缀，无明文密钥）+ 按 laneId 的滑动窗熔断注册表（阈值/窗口/开窗/总闸 env 可调，成功即关闸）；验证：单测——判开/成功关闸/总闸/指纹稳定不含 key
- [x] 3.2 `server.js`：启动时由 writeLlmProfile 的 providers 构建 `ctx.llmLaneByProvider`；验证：in-pod 标记
- [x] 3.3 `server/cron-runner.js`：模型归位后查熔断 → 开窗期返回 skipped（skipReason 带 laneId 与截止时刻）；回合缝按 outcome 记 success/failure 进注册表；验证：单测——开窗期 skip、成功关闸、a2a/tool 不查

## 4. skipped 状态

- [x] 4.1 `server/fleet-events.js` `shapeTurnOutcome`：`outcome.skipped` → status=skipped（errorKind null）；`task-engine.js` `finishExecution` 识别 `result.skipped` → state=skipped；验证：单测——engine state、failureStreak 不计、presence 推进

## 5. 降级重试

- [x] 5.1 `server/cron-runner.js` `runPersonaTurn`：「prompt+collect」抽局部函数，按解析链候选循环——仅 model_upstream 且启动 <60s 且有未试候选时重试一次，detail.degradedTo 记录；验证：单测——重试成功/候选耗尽如实失败/超时不重试

## 6. 前端与语言

- [x] 6.1 `InspectorDrawer.tsx`：lastTurn 的 skipped 琥珀色（区别于 failed 红）、timeout detail 行（「卡在 X 已等 Ys·N 步」/「预算耗尽·N 步」）、degradedTo 行；五语言键；验证：typecheck + check:locales

## 7. 收口

- [x] 7.1 全量单测（红名单仅既有 extension/manifest 族）+ `openspec validate fix-fleet-turn-attribution`
- [ ] 7.2 出片上产 + in-pod 标记实证
- [ ] 7.3 真机验收：造一次上游失败窗（或等自然流量）验证 skipped 与熔断日志；挑一条历史 timeout 岗位等下一发回合看 detail 归因；台账 §15.55 + 归档
