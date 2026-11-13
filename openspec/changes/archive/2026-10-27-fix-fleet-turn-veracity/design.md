# Design: fix-fleet-turn-veracity

## Context

本 change 是 wire §二 的收口残件（2026-10-27 用户两裁定：等 `fix-fleet-turn-attribution`
提交后接力；presence 统一不推进）。先行已落的基线：

- **§一 需关注档**（`2026-10-26-fix-fleet-failure-visibility` 上产归档）：
  `deriveMemberStatus` failing、`failureStreak` 走查（非 failed 即 break）、
  `statusCounts.failing`、前端着色。
- **就绪有界等待**（e339636e 上产）：`awaitRuntimeReadyForJob`——fleet 回合轮询等待
  冷 cell 运行时最多 120s（`RUNTIME_READY_WAIT_MS`），非 fleet 立即拒绝；等待耗尽
  目前仍记 failed/runtime_not_ready。
- **attribution 案在途**（wire §三/§四，apply 开始时 0/12）：已引入 `skipped` 事件状态
  （shapeTurnOutcome）、task-engine skipped state、`detail` 归因列、车道熔断开窗
  （开窗期回合记 skipped）、降级重试一次、web 五语。其 skipped 语义与本案收敛为
  同一枚举；本案在其提交后的干净基线上接力。
- 关键赛点：`runCronJobTurn` 的 ledger begin 在 executor 之前——要满足"skipped 不开
  实例"，未执行短路必须再前移一格，进 ledger begin 之前的 persona 分支。

## Goals / Non-Goals

**Goals:** 等待耗尽的不就绪回合记 skipped（两源同形）；skipped 在连败走查透明跨过；
presence 全源统一不推进并出诚失联文案；skipped 读面/徽标贯通。

**Non-Goals:** 就绪等待机制本体（e3396 已产）、skipped 枚举/形状/熔断/降级/timeout
归因（attribution 案）、§一全案（已产）、任务引擎重试（明确不引入）。

## Decisions

### D1 · 未执行短路的位置：runCronJobTurn persona 分支、ledger begin 之前

接力补丁=一格前移：persona 分支在 `ctx.fleetTurnLedger.begin` 之前先就绪预检
（复用 `awaitRuntimeReadyForJob` 形态，fleet 限定）；不就绪 → 直接
`ctx.recordFleetTurnEvent(job, { ok:false, skipped:true, error }, { startedAt, endedAt, ledgerTurn:null })`
并 return `{ ok:false, skipped:true, error }`——不进 ledger、不接 handoffs、不进
settle。runPersonaTurn 内部既有的 `awaitRuntimeReadyForJob` 快路原样保留为竞态兜底
（预检后桥再翻脸的窗口）。被否决的备选：在 runPersonaTurn 返回时把 ok:false 改写为
skipped（ledger 已开，实例已留痕，违背 spec"不留实例痕迹"）。

### D2 · 走查一行 continue，全源同义

`failureStreak` 循环前置 `if (r.status === "skipped") continue;`——对两源 skipped
（运行时/熔断）一视同仁；`since`/`lastErrorKind` 不被 skipped 行触碰。node:test 钉
区分场景：interrupted 中断归零（既有）vs skipped 透明跨过（新增）。

### D3 · presence 读面接线：latestRealTurn 优先、task.lastRun 回退

`fleets-db.js` 增 `latestRealTurnFor(memberId)`（status IN ok|failed|interrupted 最新行，
纯追加查询）；`deriveMemberStatus` 增可选入参 `effectiveLastRunAt`——提供时优先于
`task.lastRun`（无事件时段/预事件史回退）。`memberView` 计算并传入；失联 reason 增
skipped 分支「N 轮未执行：运行时不可用（或车道熔断）」（N=窗口内 skipped 读时计数，
与 P2 missed 文案分列）。全源统一"不推进"（2026-10-27 用户仲裁，attribution 案
proposal 的「照常推进」行由其作者对齐或归档时修正——语义仲裁已完成）。

### D4 · 同秒塌缩是等待的涌现性质，不另造去重器

就绪等待本身就是间隔：串行链首个岗位的等待覆盖重启窗；spec"至多 1 条"是上限语义。
验证锚点：e2e 9 岗同刻扇入+桥重启 5s → skipped≤1。

### D5 · 徽标的 k 读时聚合，与 missed 分列

「本轮未执行（第 k 次）」k=窗口内 skipped 行读时计数，不新增存储；skipped=触发未
跑成 vs missed=根本没触发，两文案永不合流（wire 验收口径）。

## Risks / Trade-offs

- [接力点在他人提交之后，基线漂移] → 残余补丁全部小颗粒（1-30 行级）；apply 前
  `git diff HEAD` 复核四文件 hunk 即可发现漂移。
- [attribution 案的「presence 照常推进」未按时对齐] → 本案 spec（全源不推进）与用户
  仲裁在案；若其先行归档，同步面在 openspec sync 时以本案文本为准（后归档者折叠义务
  已写进 proposal）。
- [存量 skipped 积压的岗位升级后由绿转失联] → 真相修复代价；发布记录点名。

## Migration Plan

零迁移（skipped 枚举随 attribution 案同船；detail 列由其幂等 ALTER 负责）。
发布次序：attribution 案提交 → 本案 5 补丁 + 验收 → 同班滚动；wire 根因函随发。
回退：本案全部读面与短路为增量，回滚镜像即恢复"等待耗尽记 failed"现行态。

## Open Questions

- 接力时 attribution 案的 task-engine skipped state 对 catch-up/presence 回退分支的
  影响复核（读其提交后定）。