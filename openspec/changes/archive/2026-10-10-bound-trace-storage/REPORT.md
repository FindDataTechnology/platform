# bound-trace-storage — 实施报告（2026-10-10）

## 交付物

| 文件 | 改动 |
|---|---|
| `server/trace.js` | 独立 `trace.db`（`storeDir("trace.db")` / `TRACE_DB_PATH` 覆盖）；流式 delta 不入库；小时级定时修剪（unref）+ 默认 7 天；`auto_vacuum=INCREMENTAL` + 修剪后 `incremental_vacuum`；启动时把存量行从会话索引**纯搬运**过来并 DROP 旧表 + 一次 VACUUM；`pruneNow()`/`traceStoreInfo()` 作为测试与运维缝 |
| `db.js` | migration v7 的 `trace_events` 建表语句移除（保留版本号占位）——新库不再在会话索引里建 trace 表；老库的表由 trace.js 搬运后删除 |
| `web/src/pages/TracePage.tsx` | `textChars` 改从 `assistant/message` 统计（chunk 已不存） |
| `scripts/test-trace-store.mjs` | 10 条单测覆盖四性质 + 搬运 |
| `scripts/test-llm-retry.mjs` | trace 断言改走新存储（原为直读 `db.getDb()` 的 `trace_events`） |

## 关键设计落点

- **过滤在 tap 侧**（`record()` 入队前）：delta 不消耗 seq，轨迹序号保持无空洞（design D1）。
- **保留默认 7 天**（原 14）——`TRACE_RETENTION_DAYS` 仍可覆盖；默认值变化已写进 spec 与变更记录。
- **纯搬运、无年龄过滤**：搬运后同一启动即由同一条保留策略收口——"策略只写一处"（design D5）。
  该语义在 spec 里显式成条（"the retention window applies to moved rows"），并有一条单测钉死。
- **子代理 trace 行照搬**（design D6）：chunk 策略生效后体积已降约 90%，而子代理失败正是排障价值所在。

## 验证证据

### 单测（`scripts/test-trace-store.mjs`，10/10）

- 流式 delta 丢弃、`finish` 保留且 seq 连续（`[1,2]` 无空洞）；
- 独立文件 + `auto_vacuum=2` + 新会话索引无 `trace_events` 表；
- 修剪删净过期行且 `freelist_count` 归零（空间真回收）；
- 搬运：列值逐项保留、旧表 DROP、子代理行在内、二次启动不重复（幂等）；
- 过期行搬运后即被同策略剪掉（"retention applies to moved rows" 场景）；
- 读 API（turn 列表 / model+provider 派生 / hasError 标记）与写失败隔离（关库后 record 不抛、读降级为空）。

### 本地回归

- `npm run test:unit`：**979/979 通过**（含 `test-llm-retry.mjs` 的 trace 断言迁移后仍绿）；
- `npx biome check`：零告警；`web` typecheck：通过；`check-locales`：5 语言 OK（未新增 key）。

## 实施中的修正

1. **`initTrace()` 幂等化**：改为可重入（先关旧句柄再开），测试与未来的热重载都不会泄漏句柄或留旧定时器。
2. **测试夹具的时序语义**：搬运测试初版用了 1970 年的时间戳，导致"搬进来立刻被 7 天窗口剪掉"——
   这正是设计行为（搬运无年龄过滤、保留策略统一生效）。已把该行为固化成独立场景测试，
   夹具改用窗口内时间戳。

## 尚未完成（生产窗口，需人工）

- 6.1 滚动后抽查 platform-test：`trace.db` 存在、行数等于搬运前、`app.db` 无 trace 行且体积收缩（~75MB → 会话量级）；
- 6.2 `/trace` 页面：列表/详情/textChars 正常，无 chunk 行但 `finish` 行在（token usage 可见）；
- 6.3 长驻观察：重启后不重复搬运（幂等）且修剪窗口正确。

## 体积预期（供上线核对）

platform-test 实测 trace 35.6MB / 122,250 行中 `assistant/chunk` 占 28.5MB（80%）；
delta 过滤后同类 cell 的 trace 体积预计降约 88%（保留 `finish`/`tool`/`message` 等）。
会话索引侧：搬运 + VACUUM 后从 ~75MB 收缩到会话数据量级。

---

## 生产执行记录（2026-10-10 22:38 起，随镜像 sha-61e44f7 上线）

**存量搬运在启动时自动发生**（cell `0f483a072f22ae37` 实测）：

```
[trace] moved 6886 legacy trace row(s) out of the session index
```

写后核对：`trace.db` rows=6888（6,886 搬运 + 2 条新写入）、`auto_vacuum=2`、
会话索引 `app.db` **已无 `trace_events` 表**（DROP + VACUUM 生效）。

**delta 过滤在生产实证**（按 boot 时刻切分同一 cell 的行）：

| | chunk 行数 | 说明 |
|---|---|---|
| boot 前（legacy 搬运） | 6,706 | 纯搬运不改写载荷——旧代码存过 delta，这是 spec 明确的行为 |
| boot 后（新代码写入） | 16 | `text-delta` / `reasoning-delta` / `tool-call-delta` **各 0 条**；只有 `finish`、`block-start/end`、`usage` 等非增量类型 |

新代码写入的载荷构成（boot 后）：`assistant/message` 67KB、`request/header` 36KB、
`assistant/chunk` 22KB（18 行，全是非增量小载荷）——**流式 delta 已不再落库**。

**读面**：`GET /api/trace/turns` 返回正常（turnId / durationMs / eventCount / model / provider 齐备）。
其余 cell 的搬运按其下次 spawn 惰性发生（设计如此）。

**备注**：本次上线顺带发现并修复了一个自检块缺陷（读取放在 `shutdownTrace()` 之后 →
`Cannot read properties of null`），已并入 sha-61e44f7 并补了子进程自检测试。
