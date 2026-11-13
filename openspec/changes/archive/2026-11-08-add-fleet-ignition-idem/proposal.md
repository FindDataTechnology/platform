# Proposal — add-fleet-ignition-idem

## Why

边点火（`server/fleet-handoffs.js` 的 `igniteFleetEdges`）是**无记忆**的：只要被调用，
就按声明边全员建任务。它有多条"同一回合可能被进两次"的现实路径：

- 回合执行重试（模型降级重试、运行时抖动后的重跑）
- 收口钩子重复触发（重复 finish 回调 / 恢复通道重放）
- 平台重启后同一轮被恢复执行

每次重进都会**再造一波下游**：下游同一个活干两遍、花两遍钱；若下游还有出边，倍数会往下传。
explore 里记为 P1-2「点火不幂等：重跑中游岗 → 下游翻倍；开自动重试 → N+1」
（证据 `cron-runner.js:1479`、`fleet-handoffs.js:21-168`）。

## What Changes

- 引入**点火键** `回合身份:边种类:目标岗`：
  - 回合身份优先取运行账本的 `turnId`（平台其余面就是按它归属回合的）；
  - 账本缺席时取引擎的每次执行序号（`job.roundSeq`），保证"同一次执行的重复进入"仍去重。
- 每个 hop 建任务前先查：键已出现 → 跳过（不建任务、不写重复的深度越界事件行）。
- 键写入任务的 `origin.fleet.ignition`，**不去新建存储**：判定时回读已落库的任务，
  跨重启天然成立。
- 键以**回合**为单位，不以岗位为单位：运维刻意重跑某岗、或下一轮节奏触发，都是新回合，
  照常点火（否则链条无法被重新驱动）。

## Impact

- Affected specs: `agent-fleet-orchestration`（1 个新增 requirement）
- Affected code: `server/fleet-handoffs.js`（`ignitionTurnKey` / `firedIgnitionKeys` /
  三个 hop 分支的判重与溯源戳）
- 无迁移、无新表、无新依赖；判定 O(任务数)，与既有聚合器的 `allRecords()` 扫描同量级。
