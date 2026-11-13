# bound-trace-storage — Design

## Context

事故与体积构成见 proposal.md。本设计记录实测数字与据此定下的取舍。

关键既有事实（2026-10-10 实测）：

- **载荷构成**（platform-test `3fdc7b8e8ac03b68`，35.6MB trace / 122,250 行）：`assistant/chunk` 118,113 行 / 28.5MB（80%）；`assistant/message` 521 行 / 2.1MB；`tool/result` 692 / 1.9MB；`request/header` 43 / 1.8MB；`tool/call` 666 / 0.6MB；`user/message` 123 / 0.2MB。aloadtree（35.6MB）同形。**流式 delta 是唯一的体积杠杆。**
- **子代理占比**：aloadtree 实测子代理会话 60,800 行 / 18.3MB ≈ 全部 session 事件行的 49.8%；事件类型与顶层同构（chunk 为主）。
- **`session_id` 列语义**：该列存的**不是** dsh 会话 id 而是 bridge/传输会话 id；真会话 id 在 `payload.sessionId` 内（外层 88 个 distinct id 中仅 16 个与顶层会话目录同名）。任何"按会话清 trace"的设想必须解 payload——本设计不依赖该列做保留决策（保留只按 `ts`）。
- **修剪现状**：`initTrace()` 在启动时 `DELETE FROM trace_events WHERE ts < now - retentionDays*86400000`（`server/trace.js:92`）；托管 cell 常驻，启动修剪实际上一次也不发生。无其他修剪点。
- **回收现状**：`auto_vacuum=0`（platform-test/aloadtree 实测），`freelist_count` 0（因为从未删过行）；删行后页进 freelist，文件不缩。
- **独立库先例**：网关级 `share-tokens.db`（`gateway/index.js:367`，`path.join(DATA_ROOT, "share-tokens.db")`）已是"cell 之外的独立 SQLite 库"范式；`storeDir(subdir, override)`（`paths.js:43`）是 cell 内库的落点约定（`PLATFORM_DATA_DIR/<subdir>`）。
- **TracePage 依赖**：`textChars` 聚合 `assistant/chunk` 的 `text-delta`（`web/src/pages/TracePage.tsx:164-168`）；`/api/trace/turns` 的 `has_error` 看 `turn/end` 的 payload，不受 chunk 策略影响。

## Goals / Non-Goals

**Goals:**

- 让 trace 存储对"常驻 cell + 长会话"这个真实形态**有界**：体积随保留窗口收敛，不随进程寿命增长。
- 保留排障所需的全部信号：终态正文、推理、工具调用与结果、token usage、结束原因、错误标记。
- 存量数据零丢失地换库，策略只在一处定义。

**Non-Goals:**

- 不引入外部观测栈（ClickHouse/OTLP/Loki）——本变更只修"有界"，不改观测技术选型。
- 不改 trace 的 REST/UI 形状（除 textChars 统计源）。
- 不按会话或按类型做更细的保留分级（如"错误回合永久保留"）——留待需要时再议。
- 不动 `session_id` 列的语义（bridge id）——那是既有契约，改它是另一个变更。

## Decisions

### D1: 过滤点放在 tap 侧（`record()` 入队前），不是写库侧

`trace.record()` 在入队前判断：`event_type === "assistant/chunk"` 且 `chunk.type` 属于 `{text-delta, reasoning-delta, tool-call-delta}` → 直接返回。**替代**（写库时过滤）被否：白占队列与批量事务的开销，且 seq 编号会出现空洞（`seqByTurn` 仍递增会让轨迹序号不连续，读者困惑）。放在 tap 侧则 seq 天然只对已存事件递增，轨迹序号保持连续。

### D2: 独立 `trace.db`，落在 cell 数据根的既有 store 约定上

cell 内：`storeDir("trace.db")`（即 `PLATFORM_DATA_DIR/trace.db`，与 `app.db` 同目录但不同文件）。**替代**（放网关级共享库）被否：cell 是隔离单元，trace 属于该用户，放网关级会让一个用户的可观测数据跨 cell 泄漏，也违背"每个 cell 自带全部可变状态"。**替代**（同库 + 定期 VACUUM）被否：VACUUM 需要整库重写锁，会话库体积大时停写窗口不可接受；且单文件损坏连坐问题依旧。

### D3: 定时修剪用 unref 的 interval，随 cell 生命周期

`initTrace()` 里 `setInterval(prune, 3600_000).unref()`（沿用 spawner reaper 的 `unref` 惯例，不阻退出）；启动时先跑一次（保持既有行为）。保留默认 **7 天**（`TRACE_RETENTION_DAYS` 可覆盖）。**替代**（按行数上限修剪）被否：天数语义与用户/运维的心智一致（"上周的还能看"），行数上限会随载荷大小漂移。

### D4: 回收用 `auto_vacuum=INCREMENTAL` + 修剪后 `incremental_vacuum`

新库创建时即设 `PRAGMA auto_vacuum = INCREMENTAL`（**必须建库时设**，后改需重建——这正是新库的窗口）；修剪事务提交后调 `PRAGMA incremental_vacuum`，把 freelist 页归还文件系统。**替代**（每次修剪跑全量 VACUUM）被否：全量 VACUUM 重写整库，小时级执行浪费 IO。**替代**（不回收，接受文件只增）被否：这正是 8GB 的成因之一。

### D5: 存量搬运 = 纯 move，在同一个启动事务里

启动时：若 `app.db` 仍有 `trace_events` 表且有行 → 逐行读（`turn_id, session_id, seq, ts, method, event_type, payload`）→ 写 `trace.db` → 删 `app.db` 中的表。**替代**（按 7 天过滤搬运）被否：策略只写一处（保留窗口）比两处好解释、不易出错；且用户从未要求历史 trace。**替代**（丢弃存量）被否：platform-test 最新 trace 是当天凌晨法律预设 E2E 的证据，该线工作仍在飞。搬运后 `app.db` 跑一次 `VACUUM` 收尾（一次性动作，可接受）。

### D6: 子代理 trace 行保留

子代理会话的事件全量入 trace（实测约占一半行数），保留它们——chunk 策略生效后子代理的体积同步降约 90%，而子代理失败正是排障价值最高的场景（ADR-0016 的韧性契约）。**替代**（不记子代理）被否：那会把子代理排障能力整块砍掉。

### D7: TracePage 的 textChars 改从 `assistant/message` 统计

chunk 不存后，前端聚合源改为 `assistant/message` 的 text 块长度。**替代**（保留 chunk 只为 UI 统计）被否：为一个派生数字保留 88% 的存储是本末倒置。

## Risks / Trade-offs

- **[修剪与写入并发]** 小时级修剪与批量写入同一 `trace.db`（WAL）——SQLite 会串行化，但修剪大事务可能让写入短暂 `SQLITE_BUSY`。缓解：`busy_timeout` 既有设置；修剪在事务内批量删除（按 `ts` 索引），窗口内行数有界。
- **[默认 7 天缩短]** 有人可能依赖 14 天窗口的排障材料。缓解：`TRACE_RETENTION_DAYS` 可覆盖；变更记录里显式写明默认值变化（14 → 7）。
- **[搬运期间故障]** 搬运中途崩溃 → 可能出现"两边都有"或"只搬了一部分"。缓解：搬运幂等（按 `(turn_id, seq)` 或自增 id 去重；先写后删，崩溃重跑即续）；搬运在启动早期、写路径之前完成。
- **[seq 连续性]** D1 的 tap 侧过滤让 seq 只对已存事件递增——与"每一帧都有 seq"的旧行为不同。缓解：spec 场景写明；对读者是改善（无空洞）。
- **[INCREMENTAL 依赖建库时设置]** 若新库先被创建为 `auto_vacuum=NONE` 再改设置，需重建库。缓解：库创建代码路径唯一（`initTrace` 的建表处），任务里钉死"建库即设 pragma"，并用单测断言 `PRAGMA auto_vacuum` 值为 2。

## Migration Plan

1. **上线**：随下次 fd-prod 滚动更新生效（cell 重启即触发：建 `trace.db` → 搬运存量 → 删旧表 → VACUUM 一次）。
2. **验证**：抽查一个 cell（platform-test）——`trace.db` 存在、行数与搬运前 `app.db` 的 trace 行数一致、`app.db` 中 `trace_events` 已空/不存在、`/api/trace/turns` 返回正常、`/trace` 页面 textChars 仍显示。
3. **回滚**：旧代码不读 `trace.db`，回滚后 `/trace` 看不到新行（旧表已删）——可接受（观测数据）；会话数据完全不受影响。若需完全回滚，把 `trace.db` 行倒回 `app.db`（同构表，一次 SQL）。

## Open Questions

（无。）
