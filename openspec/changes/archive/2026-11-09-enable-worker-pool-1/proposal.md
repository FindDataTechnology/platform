# Proposal — enable-worker-pool-1

## Why

单串行槽是当前产线通过率的结构性瓶颈。今天实测：两个 cell 的 `oldestQueuedMs` 达到 **92–103 分钟**，
同期每个回合只 4–5 分钟就收口——**队列不是在卡，是在排**。一条串行槽要服务一个 cell 里全部舰队的节奏任务，
高峰时重启补跑潮更是直接堆积。

7Gi 上限本来就是为这一步抬的（`harden-fleet-execution-economics 2.3` 的注释原话），但 `TASK_WORKER_MAX`
仍是 0，那一步没走。现在条件齐了。

## What Changes

- 产线 `TASK_WORKER_MAX: "0" → "1"`（**最小步长**：只加一条并行槽，不是一次开满）。
- 先核内存准入（这是能不能开的前提，不是附注）：
  - cgroup `memory.max = 7Gi`，当前 `memory.current ≈ 2.14Gi`，余量 ≈ 5.0Gi；
  - 闸门槛 = `7Gi × (1 − 0.15) = 5.95Gi`，而 `used + 足迹 ≈ 4.07–4.16Gi` → **放行**；
  - 单 worker（第二个 dsh 桥）实测基线 ~500–640MB，远小于 2.9Gi 富余。
  - 对照：11-08 在 4Gi 上限下试开 `worker=2` 空转 608 秒，正是因为门槛 3.4Gi < 4.07Gi 被拒——本次不重复。
- 开前记录回滚：改回 `"0"` 即退回串行（池为空时行为与今天逐字节一致）。

## Impact

- Affected specs: `worker-pool`（能力上限条款 + 1 场景：开池前必须过准入）
- Affected code: 无（纯部署参数）；`fd-infra-deploy/all-services/prod/platform.yaml`
- 风险：多一个 dsh 桥的内存与 MCP 卫星开销；由 `TASK_WORKER_MAX=1` + 空闲回收（5 分钟）封住。
- 不改变主链语义：未认领的执行仍走原来的串行链。
