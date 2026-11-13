# Proposal: fix-fleet-turn-veracity

## Why

无人值守舰队的回合真相最后一块 P0 失真（需求方：fd-wire 柏讯线 2026-10-26 普查；
同批 §一 已由 `2026-10-26-fix-fleet-failure-visibility` 上产，无需重来）：

**§二 · runtime_not_ready「未执行」语义缺失**。普查 178 条回合中 69 次（39%）
runtime_not_ready，其中 58 次耗时 0 秒——回合根本没启动。桥代际翻转窗（预设切换/
catalog 同步/凭据 patch/崩溃重拉）内开火即 fail-fast，且被拒的回合记成**正式失败**：
0 秒、无预算消耗、无产出、无副作用的一行与真失败同权，污染连败、推进 presence
（看起来"刚跑过"）。同秒爆发已校正为同分钟多岗位扇入（引擎无重试）。

**基线（2026-10-27 裁定，用户两轮仲裁落锤）**：就绪有界等待已由 e339636e 上产
（fleet 回合等 120s）；`skipped` 事件状态、task-engine skipped state、detail 归因列
与熔断开窗跳过正由并行 change `fix-fleet-turn-attribution` 实施（其语义定义与本案
收敛为同一枚举）。本 change 是收口：**等待耗尽的不就绪回合记 skipped 而非 failed**，
并统一 skipped 在连败与 presence 上的语义（presence 统一不推进——用户 2026-10-27
仲裁，alert 案将其 proposal 的「照常推进」对齐过来）。

## What Changes

- **等待耗尽=未执行而非失败**：fleet 回合就绪等待（既有 120s）耗尽仍不就绪时，记
  `status=skipped`、`errorKind=runtime_not_ready`——不复读为 failed；不产生重试
  （下一周期自然再来）；不开执行实例（短路早于 ledger begin）；同批至多 1 条。
- **连败走查透明跨过 skipped**：`failureStreak` 遇 skipped `continue`——不计入、不
  中断、不重置真失败链（与 interrupted 中断链条归零的既有语义明分）；`since` 与
  `lastErrorKind` 不被 skipped 行触碰。
- **presence 统一不推进（两案同一规则）**：任何来源的 skipped（运行时未就绪/熔断
  开窗）都不算「最近一次执行」；持续不可用超容忍窗后派生失联，判定依据明写
  「N 轮未执行：运行时不可用」（与 P2 missed「未触发」文案分列）。
- **读面与呈现**：`/turns` 过滤接受 `status=skipped`；岗位卡 skipped 专属徽标
  「本轮未执行：原因（第 k 次）」（k=读时窗口计数），真实执行后自消；画布节点与
  时间线同语义；五语文案。
- **spec 汇合义务**：本案与 `fix-fleet-turn-attribution` 同改
  「成员回合产出回合结果事件」——后归档者的 MODIFIED 文本须含前者的全部增量
  （skipped+detail+熔断开窗），本案 spec 已按后归档身份写好。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `agent-fleet-core`: "成员回合产出回合结果事件" 状态枚举补 skipped 两源语义
  （运行时未就绪短路 + 车道熔断开窗——后者文本为 attribution 案的归档汇合预留）；
  "在岗与健康状态为派生视图" 在需关注档之上补 skipped 交互规则（透明跨过/
  presence 不推进）；新增「回合触发前的运行时就绪等待」要求。
- `agent-fleet-cockpit`: "健康聚合一览" 落位需关注桶（同步已上产行为）与 skipped
  中性规则；"岗位卡呈现回合成败与连续失败" 增 skipped 徽标语义。

## Impact

- **代码（残余 5 处补丁，等 attribution 案提交后的干净基线上落地）**：
  `server/cron-runner.js`（等待耗尽→skipped 短路，早于 ledger begin）、
  `server/routes/fleets-db.js`（failureStreak 加一行 continue + latestRealTurnFor）、
  `server/fleet-reconcile.js` + `server/routes/fleets.js`（effectiveLastRun 接线
  与失联 skipped 文案）、`web/`（skipped 徽标/时间线/五语）、e2e 与 node:test。
  无 DB 迁移。
- **API**：回合 status 增 `skipped`（attribution 案同船带出）——发布记录向 wire 点名。
- **关联排序**：`fix-fleet-turn-attribution` 先行提交（进行中 0→12），本案接力；
  语义互锁点=skipped 枚举与 presence 规则两案一致（已仲裁）。
