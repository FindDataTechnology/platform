# Proposal — fix-stale-wake-footprint

## Why

唤醒准入把「容器当前用量 + 该 cell 的归档足迹」当投影，超 `CELL_MEMORY_ADMISSION_FLOOR` 就拒。
这条归档足迹由 `archiveFootprint()` 在挂起/销毁时写一次，**没有任何过期语义**。于是高水位残留
会永久挡住唤醒，而醒不过来就意味着永远没有机会重测——**自锁**。

生产实况（2026-11-08，cell 1da519d4c1c0bf89）：

```
[gateway] cell residency refused (memory floor): used=3481145344 limit=4294967296
  headroom=-28.1% threshold=15.0% projected=5502664532 footprint=2021519188
```

同容器另两个 cell 足迹 755MB / 788MB，本 cell 却记着 1684MB（重负载时期的残留）。驱逐链
（`evictUntilAdmissible`）只能赶走「空闲」邻居，赶完仍不够 ⇒ 拒绝 ⇒ 醒不过来 ⇒ 永不复测。
当天这个 cell 黑掉约 40 分钟，该业务线所有舰队回合全部空转。

## What Changes

- **足迹带时间戳**：`cell_registry` 新增 `last_footprint_at`（guarded ALTER，同既有模式），
  `archiveFootprint()` 与字节数同一次 `put()` 写入。
- **过期即失效**：唤醒时若足迹年龄超过 `CELL_FOOTPRINT_TTL_MS`（默认 6 小时，0 = 不过期），
  该足迹按**不存在**处理 —— 即走「这个 cell 从未被测量过」的既有路径（默认足迹），
  并在下次挂起时重写一个新数。带字节但无时间戳的旧行同样按陈旧处理（一次性解冻）。
- **证据可见性**：拒绝时额外记 `defaultWouldFit`（用默认足迹是否本可过闸）。纯诊断：
  一眼分清「旧账挡的」还是「真的不够」，日志还会点名 `the archive is the blocker`。

**不放宽任何门槛**：floor、默认足迹、驱逐链、并发预定账本都不动。改动只是让一条**证据**带上有效期。

## 非目标

- 不改 `CELL_MEMORY_ADMISSION_FLOOR` 与容器内存上限（4GiB 是刻意容量决定，有 14 次 OOMKill 前科）。
- 不改驱逐策略与空闲判定。

## 验证

- `scripts/test-cell-wake-admission.mjs` **17/17**（既有 15 例行为不变 + 新增 2 例：
  超过 TTL 的归档足迹不再挡唤醒；TTL 内的归档足迹照旧按全额判定）。
- 相邻：`test-spawner-registry` 5/5、`test-cell-crash-ledger` 4/4、`test-cell-spawner-dedup` 7/7。
