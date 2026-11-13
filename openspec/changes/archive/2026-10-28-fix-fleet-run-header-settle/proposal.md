# Proposal: fix-fleet-run-header-settle

## Why

执行实例（run）头表有一种**永远不收敛**的残留，与已归档的 `add-cockpit-run-reclaim`（2026-10-26）覆盖的是**另一种**形状：

- 那一单收的是「一条回合明细都没有」的孤儿头（进程在回合中段滚动，开了头却什么都没成）。
- 这一单收的是「**回合明细已落、但收口没跑到**」的头：`settle()` 是**内存兜底**（ledger 的句柄表随 pod 消失），
  而库侧清扫按设计跳过任何有明细的实例（`agent-fleet-runs` 主 spec 原文：「存在回合明细的 open 实例
  SHALL NOT 被本清扫改动（其收口归正常水位判定）」）。于是 pod 在「写回合行」与「收口」之间滚动，
  就留下**没有任何未来事件会关掉**的头。

生产实证（2026-10-28 全平台扫描）：**6 个头永久 open**，其中 4 个「有回合行、头没收口」，
在 cell `3fdc7b8e` / `6db2b1b4` 各挂了 6–30 小时。**症状是状态不诚实**：驾驶舱执行时间线
把它们一直显示成「进行中」——同族于 `fix-fleet-failure-visibility` 治的「假正常」。

## What Changes

- 新增**泄漏头清扫**：状态 open、开立超过宽限期（默认 30 分钟）的实例，若其回合明细已全部结束，
  且**没有在飞行的回合句柄、也没有排队/运行的引擎任务**携带它，则按既有 settle 口径收口
  ——**状态由回合行算出**（ok / partial / failed），不是新的判决。
- 判断放在 **ledger 层**而非库层：只看行的话，「上游回合已结束、下游回合还没起」的协作链
  与「没人会再来收」的泄漏**长得一模一样**；ledger 知道在飞行的句柄（open map）与引擎任务状态，
  所以能分辨二者。库层只提供 raw 清单（`listOpenRuns`），不裁判。
- 零回合行的头**仍归既有孤儿清扫**（判 failed），两套口径互不抢判。
- 清扫挂进既有保洁：进程启动时跑一次（存量自愈）+ 每小时重复。

## Capabilities

### New Capabilities
（无）

### Modified Capabilities
- `agent-fleet-runs`: MODIFIED——「孤儿执行实例头表被收口」一条补充「泄漏头」口径：
  回合明细已落但收口未到的 open 实例，由**知道在飞行情形的 ledger** 按明细算出的状态收口；
  原有「零明细 → failed」口径与「有明细的实例不受孤儿清扫改动」保持不变（改为不受**孤儿**清扫改动，
  另由新口径收口）。

## Impact

- 后端：`server/fleet-runs.js`（`sweepOpenRuns`）、`server/routes/fleets-db.js`（`listOpenRuns`）、
  `server.js`（启动即跑 + 每小时）。
- 零前端、零 API 变化；时间线只是不再出现永久 open 的陈旧头。
- 非目标：不伪造 usage；不收回已有明细；不改动「零明细判 failed」的既有语义；
  不做「pod 重启即全 cell 收口」（跨 cell 直写会引入多写者竞争，见台账 §15.76）。
