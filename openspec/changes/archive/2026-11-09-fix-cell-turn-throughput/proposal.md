# Proposal — fix-cell-turn-throughput（回溯登记）

## Why

代码已于 2026-11-08 上产，但从未留 OpenSpec 记录 —— 本 change 是**补登记**，不是新实施。
三处行为在生产上各踩过一次真实故障：

1. **重启补跑潮饿死执行槽**：cell 只有一条串行执行槽（`TASK_WORKER_MAX=0` 是刻意的容量决定，
   节点预算不含并行 dsh 子进程）。一次重启的 catch-up 潮会堆出数小时积压 —— 2026-11-08 实况
   18 个执行排队、最老 3.5 小时，而人工 `run now` 等满 180s 仍看不到自己那轮。
2. **陈旧度量不出来**：`queuedAt` 是「本轮等待时钟」，`enqueueExecution` 每次重入队都重打，
   `drainRepairQueue` 在 boot 时也重打（故意为之，免得探针报「等了 12 小时」）。于是每次重部署
   都把整批积压洗成「刚入队」，按它算年龄永远量不出东西。
3. **人点的 run-now 被判陈旧丢掉**：`run now` 不改变作业属性，`trigger` 仍是 `schedule`，
   于是排期轮专用的年龄上限把操作者自己点的那轮丢了（实测 error 原文
   `queue staleness: a scheduled fire waited 28min …`）—— 正是「run-now lost」本身。

## What Changes

- **有界陈旧度**：排期触发在队列里等超过 `QUEUE_MAX_AGE_MS`（默认 30min，部署钉 10min，0 关闭）
  即以 `skipped` 丢弃：不烧预算、不留执行实例、error 写明分钟数与上限，由下一次排期接替。
- **锚点按首次入队计**：新增 `firstQueuedAt`，每次队列驻留只打一次，跨重入队与重启存活，
  离开队列（真跑或丢弃）时清空。
- **锚点必须持久化**：`saveTasks()` 是白名单式序列化，不写进去就等于每重启一次丢一次 ——
  补 `firstQueuedAt` 一行。
- **谁点的决定是否可丢**：队列驻留记录 `queuedBy`（`human` / `cadence`），随锚点一起持久化；
  年龄策略只丢 `queuedBy !== "human"` 的排期轮。人工 `run now`、手工/事件触发永不过期。

## 非目标

- 不增加并行执行槽（`TASK_WORKER_MAX=0` 不动）。
- 不改 watchguard / 就绪阶梯（那是 fix-fleet-readiness-retry 的范围，已归档）。
- 不改 CLI 与 UI 的措辞。

## 上产记录（回溯）

- 引擎：`848698068`（有界陈旧度）、`71cec3ae7`（锚点按首次入队）、`aec88cebf`（锚点持久化）、
  `1287bf521`（`queuedBy` 人点豁免）。
- 部署：GitOps `fd-infra-deploy` 的 `platform.yaml` / `facet.yaml` 提升到携带上述提交的快照，
  并在清单里钉 `QUEUE_MAX_AGE_MS: "600000"`。
- 生产实证：2026-11-08 三次真实丢弃（40min / 31min / 28min），队列 21 → 13；
  `queuedBy: human` 的 `run now` 两次拿到真回合（`queuedForMs` 48604 / 173947 → `running` → `done`）。
