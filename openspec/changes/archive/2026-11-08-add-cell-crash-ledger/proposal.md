# cell 崩溃要可观测、要有界——现在崩了只留一行日志

## Why

cell 的**崩溃隔离**是今天架构里最值钱的一条保证：一 cell 一进程，某个 cell 抛未捕获异常
只死它自己，其他用户的 cell 不受影响（`gateway/spawner.js:344` 的注释原话 "other users'
cells are untouched"；仓库里也**没有** `uncaughtException` 全局兜底，未捕获异常默认直接打死
进程）。这条保证是「不把 cell-server 并进 gateway 进程」的唯一硬理由，所以它不能拿来交易。

但同一个退出处理里，**崩溃只做了一件事**：

```js
} else {
  reg(userId, { type: "down", now: Date.now() });   // 只落一个 down 事件
}
...
cell.state = "error";
cell.error = `exited (code=${code} signal=${signal})`;
console.error(`[gateway] cell ${userId} exited unexpectedly: ${cell.error}`);
```

`cell.error` 只在内存里，进程一滚就没了；`cell_registry` 里没有任何崩溃计数或最近崩溃现场。
实测（2026-11-08 fd-prod）：台账 `destroy_reason` 全空、当前 pod 日志 0 次异常退出——**但这只覆盖
当前 pod 的 1.5 小时**，当天滚了四次，历史全丢。也就是说「这个 cell 到底稳不稳」今天**答不出来**，
而这正是判断「要不要为省 220–280Mi 去动崩溃域」的前提数据。

另有一条真实的付费信号顺带暴露：7 个 cell 的 `last_gate_refusal_json` 记录着
`headroomPct≈0.0105`、`projectedBytes 4.25GB > limit 4GB` —— **唤醒被内存闸拒过**，而拒了几次、
之后有没有醒来，今天同样无处可查。

## What Changes

- **崩溃现场落账**：非预期退出（非 `stopping`、非 demo 清理）时，在台账上累计 `crash_count`
  并写 `last_crash_json`（`code` / `signal` / `at` / 运行时长）。列用既有的 **guarded-add**
  先例添加（`try { ALTER TABLE … ADD COLUMN } catch {}`，同 `last_gate_refusal_json` /
  `last_footprint_bytes`），行形状走 `migrateRegistryRow`。
- **启动失败单独计数**：`bindFailed` 目前只落事件不计数；补 `bind_failure_count` 与
  `last_bind_failure_json`，让「起不来」与「跑着崩」分开看。
- **有界但不锁人**：`crash_count` 在窗口内超阈值时，**只加告警与退避**（下一次唤醒的 respawn
  延迟按次数指数增长），**不做硬拒绝**——硬拒会把用户永久锁在门外，这是 mp-demo 那次
  tombstone 事故的教训（同文件注释已写明）。
- **进观测面**：内存面 `cells[]` 每行带 `crashCount` / `lastCrash`；`/healthz` 增
  `cellsInError` 计数；拒醒次数随 `lastGateRefusal` 一起暴露。

## Capabilities

### New Capabilities

- `cell-crash-ledger`: 崩溃与启动失败的持久计数、最近现场、退避与观测面。

### Modified Capabilities

- `cell-lifecycle`: 非预期退出的处理从「只落 down 事件」扩展为「落 down + 崩溃计数 + 现场」，
  且**持有语义不变**（不写 destroy 墓碑、不停用账号）。

## Impact

- **代码**：`gateway/cell-registry.js`（guarded-add 两列 + 行形状迁移）、
  `lib/cell-registry.js`（`REGISTRY_SCHEMA_VERSION` / `migrateRegistryRow`）、
  `gateway/spawner.js`（退出分支计数、respawn 退避）、`gateway/memory-face.js`（行字段）、
  `gateway/index.js`（healthz 计数）。
- **数据**：`cell_registry` 加两列（可空，老库照常读；不改既有列语义）。
- **契约**：崩溃**不会**导致持有关系变化；不新增 destroy 墓碑；不改变唤醒准入的判定逻辑
  （只把拒醒记录带出来）。
- **风险**：`crash_count` 会随进程重启累计而不清零——需要一条「成功运行 N 分钟即视为康复、
  计数归零（保留 last_crash）」的口径，否则热修后仍显示历史崩溃。
