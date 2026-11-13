# Proposal: add-cockpit-run-reclaim

## Why

执行实例账本有一种永远不收敛的残留：回合 `begin()` 铸了头表，但该回合一行都没落就消失（进程滚动/崩溃在回合中段），此后**没有任何后续事件能收口它**——settle 兜底挂在引擎终态任务上，而丢失的回合不产生终态事件。真机实证：`run_d92b41` 敞开 7 小时、零回合、永久占据时间线首位。

## What Changes

- 新增孤儿头表清扫：状态 open、超过宽限期（默认 30 分钟）、且**一条回合明细都没有**的头表，收口为 failed（endedAt = 自身开立时刻，turns 0）——语义诚实：开了却什么都没成。
- 清扫挂入既有每小时保洁，并在**进程启动时先跑一次**（泄漏多由上一个进程造成，本进程的监听器等不到它）。

## Capabilities

### New Capabilities
(无)
### Modified Capabilities
- `agent-fleet-runs`: ADDED——孤儿 open 头表在宽限期后被收口为 failed，且在进程启动与每小时保洁时执行；有回合明细的 open 头表不受此清扫影响（归 settle 管）。

## Impact

- 后端:`fleets-db.js`(`reclaimOrphanRuns` + 并入 `pruneRuns`)、`server.js`(启动即跑 + 每小时)。
- 零前端、零 API 变化;时间线只是不再出现永久 open 的空壳。
- 非目标:不伪造 usage;不收回已有明细;宽限期不做成可配置。
