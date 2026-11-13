# Tasks — fix-stale-wake-footprint

## 1. 足迹带时间戳

- [x] 1.1 `cell_registry` 新增 `last_footprint_at`（guarded ALTER），并进 serialize/deserialize 与 INSERT/UPSERT（含 `COALESCE` 保留旧值）
- [x] 1.2 `archiveFootprint()` 与字节数同一次 `put()` 写入时间戳

## 2. 过期即失效

- [x] 2.1 唤醒路径按 TTL 判新鲜度：过期或无时间戳 ⇒ 视为无归档 ⇒ 用默认足迹；`ttl <= 0` 关闭过期
- [x] 2.2 判定为过期时打日志（含原足迹大小、年龄、改用默认足迹），便于排障
- [x] 2.3 `CELL_FOOTPRINT_TTL_MS` 从 `gateway/index.js` 注入（默认 6h）

## 3. 证据可见性

- [x] 3.1 拒绝时计算并记录 `defaultWouldFit`；为真时额外 warn「the archive is the blocker」

## 4. 验证

- [x] 4.1 `test-cell-wake-admission` **17/17**：既有 15 例语义不变（夹具补时间戳以表达「新鲜档案」），新增 2 例覆盖 TTL 内/外
- [x] 4.2 相邻：`test-spawner-registry` 5/5、`test-cell-crash-ledger` 4/4、`test-cell-spawner-dedup` 7/7
- [x] 4.3 `node --check` + biome 通过

## 5. 收口

- [x] 5.1 出片 + GitOps 滚版，并在产上确认
  - 镜像 `sha-709e12b`（快照基底含 paas 6450c35cf）；ccr relay OK 2026-11-09T14:08:17+08:00；GitOps `52305f8`
  - 期间 `sha-a8321dc` 的基底早于本提交（容器内 `last_footprint_at` = 0），故显式滚回含本改动的 tag；滚后复核
    `fp=6 sweep=2 sat=*`（足迹时间戳/队列清扫/他线卫星共享三者共存，未互顶）
  - 产上证据：`cell_registry` 已有 `last_footprint_at` 列；活跃 cell 的足迹**带时间戳**
    （`3fdc… 831MB stamped`、`1da5… 900MB stamped`），历史残留行仍 `legacy-no-stamp`（按设计一次性解冻）；
    cell 1da519d4c1c0bf89 的高水位由 1684MB 重测为 **900MB** —— 正是当初锁死它的那个数
