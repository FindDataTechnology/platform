# Proposal — fix-queue-staleness-sweep

## Why

`fix-cell-turn-throughput` 的年龄上限**只在出队时判定**。于是它实际约束的是「拿到执行槽」，
而不是「等得太久」。生产实况（2026-11-09 04:5x，cell 1da519d4c1c0bf89）：

```
job_1793413192186_g51s7b   queued   cadence   ageMin=80.3   trigger=schedule
```

这条排期轮排了 80 分钟：human 点火与手工轮持续插队，它永远到不了队头，因此那唯一一次判定
永远轮不到它。两个后果：

1. **该丢的没丢**：一条早已过时的排期轮一直占着「待执行」的名额，下一次排期也无法接替它。
2. **探针假红**：`queueHealth().degraded` 由「最老排队 > 10 分钟」判定，而 `/api/ready`
   是 `ctx.ready.dsh && !queue.degraded`。一条永不到队头的老排期轮让探针**永久 503**，
   而 cell 其实健康（`dshInitError: null`、同刻还有 turn 正在跑）。部署/e2e 探针据此会把
   健康实例判成没起来 —— 这正是 `fix-task-queue-deadlock` 想消灭的那种「假绿/假红」。

## What Changes

把同一个判定抽成 `dropIfStaleQueued(t, now)`，两个调用点：

- 出队路径（原有位置，行为不变）；
- **新增周期清扫** `sweepStaleQueuedFires()`：引擎初始化后起一个 60 秒的 unref 定时器
  （`QUEUE_STALE_SWEEP_MS` 可配），扫一遍内存里的队列，把超过上限的 cadence 轮按 `skipped`
  丢弃 —— 不需要它先赢得执行槽。丢弃仍然不烧预算、不建实例、不留台账，所以扫得再勤也免费。

不变的部分：`queuedBy === "human"` 的人工点火仍然永不过期；`trigger !== "schedule"` 的手工/事件轮
永不过期；`QUEUE_MAX_AGE_MS=0` 仍然整体关闭该策略（清扫也随之关闭）。

## 非目标

- 不动调度公平性（`FLEET_FAIR_QUEUE`）与执行槽数量。
- 不改探针阈值；清扫让它自愈，而不是把阈值调松。

## 验证

- `scripts/test-queue-staleness.mjs` 8/8，新增两例：被长期插队的 cadence 轮被清扫且
  `queueHealth().degraded` 由 true 恢复 false；人工点火与正在跑的轮永不被清扫。
- 相邻：`test-queue-watchdog` 3/3、`test-fleet-turn-events` 15/15、`test-queue-health` 10/10。
