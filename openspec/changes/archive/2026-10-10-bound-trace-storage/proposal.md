# Proposal: bound-trace-storage

## Why

会话索引库被删的直接原因是体积：小说用户 cell 的 `app.db` 涨到 **8GB**，其中约 **7.5GB 是 `trace_events`**（会话证据只占零头 ~236MB），磁盘 79% 逼得清障只能删整库。trace 之所以失控有三个叠加的成因：

1. **载荷全是原始增量**：`assistant/chunk` 的流式 delta 逐条落库。platform-test 实测该类型占 payload 字节 **88%**（28.5/35.6MB），而终态正文与推理在 `assistant/message` 里已完整保留——chunk 对事后阅读是冗余。
2. **只在启动时清理**：保留窗口（14 天）的修剪挂在 `initTrace()`，而托管 cell 是常驻进程，**启动一次就再不修剪**；子代理会话的事件同样入 trace（实测约占 50% 行数），进一步放大。
3. **删行不还盘**：`auto_vacuum=0`，删掉的页留在 freelist 里，文件只增不减——即使修剪发生，磁盘也不会回收。

于是 trace 成为"必然涨到把库撑爆"的结构性问题。本变更把 trace 存储变成**有界**：定时修剪、载荷去冗余、独立库文件、存量搬运收口。

## What Changes

- **载荷去冗余**：`assistant/chunk` 中纯流式 delta（`text-delta` / `reasoning-delta` / `tool-call-delta`）不再落库；保留非增量 chunk（`finish` 等，含 token usage 与结束原因）——**预计体积降约 88%**。终态正文/推理仍在 `assistant/message`，工具证据仍在 `tool/call`/`tool/result`，排障所需的信号一个不少。
- **定时修剪**：保留窗口（`TRACE_RETENTION_DAYS`，默认 **14 → 7**）的修剪改为**小时级定时**执行（不再只在启动跑一次），常驻 cell 因此真正有界。修剪同时改为 `VACUUM` 有条件触发或 `INCREMENTAL` 回收（见 design），确保删行后磁盘回收。
- **独立库文件 `trace.db`**：trace 从 cell 的 `app.db` 迁到同级独立库（网关级已有 `share-tokens.db` 先例；`storeDir` 语义不变）。会话数据与观测数据从此互不牵连：清 trace 不碰会话，重建索引不碰 trace，单文件损坏不再连坐。
- **存量搬运**：现有各 cell `app.db` 里的 trace 行整体搬进新建的 `trace.db`（纯搬运，无年龄过滤——策略只写一处：交给同一条 7 天定时修剪自动收口）。子代理会话的 trace 行**保留**（chunk 策略生效后体积已降约 90%，而子代理失败正是排障价值所在）。
- **前端小改**：TracePage 的 `textChars` 统计从 `assistant/chunk` 改为从 `assistant/message` 统计（chunk 已不存）。
- **契约化**：`turn-tracing` spec 的"存储有界"要求改写——修剪窗口 + 载荷策略 + 独立库 + 定时执行，四者入 spec。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `turn-tracing`: "The server captures the full dsh event stream for every turn" 的载荷范围收窄（流式 delta 不入库、非增量 chunk 保留）与"Trace storage is bounded"改写（独立 `trace.db`、小时级定时修剪、默认 7 天、删行后回收）。

## Impact

- **改动**：`server/trace.js`（载荷过滤、独立库连接、定时修剪、回收）、`server/dsh-events.js`（若过滤点选在 tap 侧）、`web/src/pages/TracePage.tsx`（textChars 统计源）、`db.js`（trace 表移出 app.db 的迁移/建表位置）。
- **数据**：存量搬运（各 cell trace 行 → `trace.db`）；`app.db` 收缩（platform-test/aloadtree/993082378 三个库各 ~75MB → 会话数据只剩零头）。一次 VACUUM 收尾。
- **不改**：trace 的 REST 读取面（`/api/trace/*` 形状不变）、`turn_id`/`session_id`/`seq`/`ts` 语义、`/trace` 路由与视图（除 textChars 统计源）。
- **依赖**：无新外部依赖（better-sqlite3 已在用；`node:zlib` 已有先例）。
