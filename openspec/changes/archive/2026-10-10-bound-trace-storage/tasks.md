# Tasks: bound-trace-storage

## 1. 载荷过滤（tap 侧）

- [x] 1.1 `server/trace.js` `record()`：`assistant/chunk` 且 `chunk.type ∈ {text-delta, reasoning-delta, tool-call-delta}` 直接返回（seq 不为未存事件递增）——单测：喂三类 delta 事件断言零行、喂 `finish` 断言一行且 seq 连续
- [x] 1.2 回归既有 trace 单测（`server/trace.js` 的 retention 测试与 `record` 覆盖）——`npm run test:unit` 全绿

## 2. 独立 trace 库

- [x] 2.1 `trace.db` 建库：`storeDir("trace.db")` 落点（`PLATFORM_DATA_DIR/trace.db`）、建表（同 `trace_events` 结构 + 两个索引）、**建库即 `PRAGMA auto_vacuum = INCREMENTAL`**——单测断言 `PRAGMA auto_vacuum` == 2 且表/索引存在
- [x] 2.2 `trace.js` 的读写全部改走该连接（`insertStmt`/`listTurns`/`getTurn`/prune）；`db.js` 的 `trace_events` 建表从 app.db 迁移链中摘除（保留只读兼容读取以支持搬运）——单测：新库写入后 `app.db` 无 trace 行
- [x] 2.3 `/api/trace/turns` 与 `/api/trace/turns/:id` 回归（读新库）——既有 route 单测/手动 curl 通过

## 3. 定时修剪与回收

- [x] 3.1 `initTrace()`：启动跑一次修剪（保持既有）+ `setInterval(prune, 3600_000).unref()`——单测：伪造 `TRACE_RETENTION_DAYS` 与旧行，断言启动即删；断言 interval 已注册且 unref
- [x] 3.2 修剪事务后 `PRAGMA incremental_vacuum`——单测：写入大量行 → 删 → 断言 `freelist_count` 归零且文件大小不增长
- [x] 3.3 保留默认值 14 → 7（`TRACE_RETENTION_DAYS` 仍可覆盖）——单测断言默认 7；变更记录写明默认值变化

## 4. 存量搬运

- [x] 4.1 启动时搬运：检测 `app.db.trace_events` 有行 → 逐行写 `trace.db`（保留 `turn_id/session_id/seq/ts/method/event_type/payload`）→ 删旧表 → `app.db` 一次 `VACUUM`——单测：造一个含 trace 行的 app.db，断言搬运后行值逐列相等、旧表已删
- [x] 4.2 搬运幂等与崩溃续跑：`(turn_id, seq)` 去重或事务边界，重跑不重复——单测：连跑两次断言行数不变
- [x] 4.3 子代理行照搬（不按会话类型过滤）——单测：搬运含 `payload.sessionId` 为子代理会话的行，断言存在

## 5. 前端

- [x] 5.1 `web/src/pages/TracePage.tsx`：`textChars` 从 `assistant/message` 的 text 块统计——`npm --prefix web run typecheck` 通过 + 手工打开 `/trace/:turnId` 断言字符数仍显示
- [x] 5.2 五语言文案不变（无新 key）——`npm run check:locales` 通过

## 6. 生产验证（fd-prod 滚动后）

- [x] 6.1 滚动后抽查 platform-test cell：`trace.db` 存在、行数等于搬运前 `app.db` trace 行数、`app.db` 已无 `trace_events` 行、`app.db` 体积显著收缩（~75MB → 会话量级）
- [x] 6.2 `/trace` 页面：列表有行、detail 有事件、textChars 显示、无 chunk 行但 `finish` 行在（token usage 可见）
- [x] 6.3 长驻观察：重启一次 cell，确认第二次启动不再重复搬运（幂等）且修剪窗口正确
- [x] 6.4 归档前 `openspec validate bound-trace-storage --strict` 全绿
