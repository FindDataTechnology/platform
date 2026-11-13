# Tasks: fix-fleet-turn-veracity

> 基线（2026-10-27 裁定在案）：§一 已由 `2026-10-26-fix-fleet-failure-visibility` 上产；
> 就绪等待已由 e339636e 上产（fleet 回合 120s）；skipped 枚举/形状/熔断/detail 由并行
> `fix-fleet-turn-attribution` 实施（74a0d342 先行提交）。本 tasks=该基线上的残余收口。

## 1 · 未执行短路（cron-runner）

- [x] 1.1 runCronJobTurn persona 分支：ledger begin 之前增 fleet 限定就绪预检（复用
  awaitRuntimeReadyForJob 形态）；耗尽→recordFleetTurnEvent 记 skipped（无 ledgerTurn）
  并 early-return；node:test 钉：无 run header/无 handoffs/同批≤1 条
- [x] 1.2 复核 attribution 案的 breaker 短路与本短路的位置序（ready 预检→熔断，同
  函数两源不互踩——熔断在 ledger begin 后的 executor 内，记录在案）

## 2 · 事件流与读面

- [x] 2.1 `fleets-db.js failureStreak`：skipped 前置 `continue`（不计入/不打断/不重置）；
  node:test 区分 interrupted（中断归零）vs skipped（透明跨过）
- [x] 2.2 `fleets-db.js latestRealTurnFor(memberId)`（status IN ok|failed|interrupted
  最新行）+ `skippedCount(memberId,{sinceMs})`；`/turns` 过滤接受 `status=skipped`
- [x] 2.3 `fleet-reconcile.js deriveMemberStatus` 增 effectiveLastRunAt/skippedRounds
  入参 + 两个失联分支挂「N 轮未执行」文案；`routes/fleets.js memberView` 接线
  （latestRealTurn 优先，无事件回退 task.lastRun）+ skippedRounds 下发读面

## 3 · 前端呈现

- [x] 3.1 岗位卡 skipped 专属徽标「本轮未执行 · errorKind ×k」（muted，真实执行
  后自消）；与 missed（未触发）文案分列；失败/中断 chip 分支排除 skipped
- [x] 3.2 画布节点 skipped chip（muted ×k）+ 检查器回合时间线 skipped 行 muted 着色
- [x] 3.3 五语文案增量（`fleets.turn.skipped`：zh-CN/en/es/fr/ja）+ web typecheck 绿

## 4 · 验收

- [x] 4.1 同刻扇入塌缩锚点：node:test 桥重启 120ms+3 岗串行→0 条 skipped（首岗等待
  吸收窗口）；持久故障→每发 1 条 skipped、零 0 秒 failed
- [x] 4.2 node:test：real-failed/skipped/real-failed→streak=2；skips-only→streak=0；
  interrupted 中断归零不回退
- [x] 4.3 node:test：跳过窗超容忍→失联且 reason 挂「N 轮未执行」；需关注优先级不回退；
  e2e fleets 全套 22/22（含新 skipped 徽标用例）
- [x] 4.4 真机验收（sha-99e6aaf 在产实证）：turns?status=skipped 200、400 文案含枚举、
  memberView 带齐 failing/streak/skippedRounds、bundle 含徽标键；skipped 自然行暂零
  （等待吸收滚版窗=设计目的），长故障窗实证列为台账观察项

## 5 · 收尾

- [x] 5.1 wire 根因函 `docs/fleet-turn-reliability-response.md`（两处普查推断校正、
  skipped enum 预告、§一已上产说明；§三/§四已实施待出片——随发布同发）
- [x] 5.2 台账 §15.59 登记；`.env.example` 的 `FLEET_TURN_READY_WAIT_MS` 入册
- [ ] 5.3 出片上产后：openspec validate/sync 折叠 attribution spec 文本（presence 行
  对齐仲裁）→ `/opsx:archive`；add-cell-lifecycle 的唤醒环挂账（skipped 是其场景）
