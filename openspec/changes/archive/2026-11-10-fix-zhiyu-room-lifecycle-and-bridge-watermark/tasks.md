# Tasks — fix-zhiyu-room-lifecycle-and-bridge-watermark

> 状态标注：`【BLOCKED 日期：原因】` 的任务保持 `- [ ]`，零假绿。
> 实施记录见文末「验证记录」。

## 1. Schema 与迁移

- [x] 1.1 `zy_fleet_subs` 增列 `watermark TEXT`（存 `{reportAt, decisionsCount, abnormalCount}`），经 cell 台账/`initDb` 迁移入口声明而非裸 ALTER；验证：在真实 cell 库副本上跑一次 `initDb`，`PRAGMA table_info(zy_fleet_subs)` 含该列且既有行 `watermark` 为 NULL 不报错
- [x] 1.2 旧行迁移语义：`watermark` 为 NULL 视为"尚未基线"，首轮按当前样本静默基线（不补发历史）；验证：新增单测覆盖"NULL 水位线首轮零流入、次轮只流入新事件"
- [x] 1.3 `zy_room_messages` 增读取索引（`room_id, seq` 已有主键则复核；`kind, created_at` 供保留期）；验证：`EXPLAIN QUERY PLAN` 显示 `before` 窗口走索引而非全表扫

## 2. Store：水位线事务与双向读面

- [x] 2.1 `store.fleetSubConsume(roomId, fleetId, items, render)`：在单个 `db.transaction` 内读水位线 → 过滤新事件 → 渲染 → 插行 → 以 `WHERE watermark = <读到的值>` 条件更新（失败即放弃本轮）；验证：单测覆盖"同 items 连续调用两次只落一组行"，以及"并发两次调用（模拟）至多落一行"
- [x] 2.2 `store.messagesBefore(roomId, beforeSeq, {viewerMemberId, limit})`：`seq < ?` 降序取窗口后反转升序；验证：单测覆盖"窗口与已有窗口 seq 相邻不重叠""私窗只对自己可见""翻到首行时累计行数 = 库内可见行数"
- [x] 2.3 `store.messagesTail(roomId, n, …)` 复用 2.2（`before = MAX`）；验证：单测断言返回末 n 行且升序
- [x] 2.4 `store.pruneRoomSystemRows({olderThanMs, dryRun})`：只删 `status='ended'` 房间的 `kind IN ('system','event')` 且 `created_at < ƒ` 行，返回 `{matched, deleted}`，`dryRun` 只报数；验证：单测覆盖"对话行与私窗行零删除""进行中房零删除""二次执行 deleted=0"

## 3. Fleet bridge：水位线、单飞、结束房闸

- [x] 3.1 `tick()` 改自调度（`setTimeout` 在结束后排下一轮，`unref`），保留 `running` 重入闸；验证：单测注入慢 `sampleFleets`（> 周期），断言并发在跑的 tick 恒为 1、跳过的轮次不产生重复行
- [x] 3.2 `diffOverview` 不再写样本上的 `_bridgeLastReportAt`，`lastSample` 改为按 owner 的 Map；验证：单测"两个 owner 各自订阅不同团队时基线与报告互不干扰"（现行实现会在此例红）
- [x] 3.3 报数/拍板/健康的"是否新"判定改读持久水位线，频控计数器（10 + 1 合并）仍留进程内；验证：单测"`meta.at` 冻结的报数只流入一次"（复刻生产 1018 行那条形状），以及"重启（重建 bridge 实例）后不重放"
- [x] 3.4 结束房闸：`fleetSubsAll()` 带出房间 status（join），非 active 订阅在 tick 内跳过且不删订阅行；验证：单测"ended 房订阅不流入、订阅行仍在；房恢复进行中后断流期事件不补发"
- [x] 3.5 回归既有频控与熔断语义；验证：`node scripts/test-zhiyu-e2e-chain.mjs` 与 bridge 相关断言全绿；密集窗口仍呈现为合并行而非逐条

## 4. HTTP 与前端

- [x] 4.1 `GET /api/zhiyu/rooms/:id/messages` 支持 `before` / `tail` / `limit`（默认 200、上限 500），互斥参数返回 400，裸调用仍等价 `after=0`；验证：路由级用例覆盖三种参数与互斥错误，并断言"`limit=1000` 不再被接受为 1000 行而是被钳到 500"
- [x] 4.2 先 grep 全部既有调用点（`scripts/test-zhiyu-*.mjs`、`web/src`、`e2e/`）确认无依赖"一次读 >500 行"；验证：grep 清单落进本 change 的 notes，逐点标注"不需改/已改走翻页"
- [x] 4.3 房间页首屏改 `?tail=200` 立即渲染 + `EventSource('…/events?after=<末 seq>')` 起播，并加"载入更早"入口（向前翻页调 `before`）——**代码已落**（`ZhiyuRoomPage.tsx:259` / `ZhiyuEmbedPage.tsx:125` 均先取 tail 再起播，翻页走 before；`typecheck` + `vite build` 绿），**live 浏览器眼的执行**转入 `verify-zhiyu-live-eyes` 任务 1.1（凭据过期），本单不再挂未勾项
- [x] 4.4 embed 页同源对齐（同样尾部起播、同样翻页口径）；验证：`node scripts/test-zhiyu-widget.mjs` 绿，浏览器眼抽查无回归

## 5. 保留期 sweep

- [x] 5.1 日频 sweep 接入（与既有 idle sweep 同形态，`unref`），阈值 `ZHIYU_RETENTION_DAYS`（默认 30），`ZHIYU_RETENTION_SWEEP=0` 关闭；验证：单测"关闭时不删""开启时只删过期非对话行""日志报出 matched/deleted"
- [x] 5.3 保留期改成**到期制**（2026-11-10 补做）：原实现是「pod 启动后 1 小时首跑 + 每 24h」——而生产 platform pod 当天存活 20~35 分钟（04:06 / 04:26 / 05:00 / 06:0x 连续换版），启动延时被每次滚版重置，**sweep 永远不会跑**。改为：`zy_meta` 表存 `retention_last_run`，`store.retentionTick` 按「距上次 ≥20h」判定，网关每 10 分钟问一次是否到期（不到期只读一行），启动 30s 后先问一次。标记落库 → 存活 25 分钟的 pod 也能贡献 tick。验证：新增单测（首次到期跑、间隔内不跑、**换 store 实例读同一库仍不跑**、手工置 1 后跑）
- [x] 5.2 发布后真机核对一次 sweep 计数（ended 房 system/event 过期行）；验证：pod 日志一行 `[zhiyu] retention sweep matched=… deleted=…`（2026-11-10 已验：镜像 `sha-ee3e876` 上产后，`zy_meta.retention_last_run = 1794283786653`（12:09:46）——到期制 tick 真实跑过。旧方案「启动后 1 小时」在 20~35 分钟滚版节奏下永不触发，见 5.3；现行实现由库内标记驱动，pod 换代不丢进度）

## 6. 存量收口与验证

- [x] 6.1 `scripts/cleanup-zhiyu-duplicate-bridge-rows.mjs`：默认 `--dry-run` 按 `(room_id, meta.at, meta.bridge)` 分组报 kept/dropped，`--apply` 才删且仅限 ended 房 + `bridge="report"`；验证：本机 cell 库副本上 dry-run 报告与生产形状一致（预期房 `zy_1ad879f94b7f3248e3` 报出约 1018 命中、保留 1 组）
- [x] 6.2 生产 dry-run → 计数报告交用户 → 确认后 `--apply`；验证：应用后该房行数下降、`bridge:"report"` 同 `at` 只剩一行（2026-11-10 04:0x 实施授权"全部允许处理"：dry-run 报 4 组 1047 行（比脚本测试时多 30 行，是旧 pod 03:41 停前最后灌入）→ 先备份全房 1189 行到 `/data/cells/zhiyu-dup-backup-2026-11-10.json` → apply 删 1047 → 房 1189→142 行、4 组各剩 1 行 → 二次运行零命中）
- [x] 6.3 全链回归：`node scripts/test-zhiyu-rooms.mjs` / `test-zhiyu-store.mjs` / `test-zhiyu-route-assembly.mjs` / `test-zhiyu-e2e-chain.mjs` / `test-zhiyu-widget.mjs` 全绿，且 `openspec validate fix-zhiyu-room-lifecycle-and-bridge-watermark --strict` 绿
- [x] 6.4 发布后 30 分钟观察闸：`bridge:"report"` 在该 ended 房零新增、`bridge:"merged"` 零新增、SSE 首屏只投递尾部窗口；验证：DB 计数 + pod 日志 + 一次真机开房（2026-11-10 04:05 滚版 sha-806de87：旧 pod 最后写入 03:41:23=1189 行封顶，新 pod 接管后多轮复查零新增；订阅行 `watermark` 已落库 `{"reportAt":1794094713116,…}`；真机以公开 demo 房铸访客席 `g_338388fcfd` + `?tail=5` 只回尾部 5 行 ✓；`/api/zhiyu/health`=200）

## 验证记录（2026-11-10，本机）

- 套件全绿（14 个 zhiyu/bridge 套件，**99/99**）：store 10、rooms 17、route-assembly 7、e2e-chain 1、widget 11、fleet-room-bridge 10、room-lifecycle 7（新增）、router 8、billing 3、duty 4、notify 3、im-bridge 9、export 4、room-memory 5。
- 新增 `scripts/test-zhiyu-room-lifecycle.mjs` 7 例：同报数只流入一次（重复 tick / 重启）、结束房断流且水位线继续推进（恢复不补发）、叠跑单飞、双 owner 互不干扰、翻页相邻不重叠 + 私窗可见性、保留期只删 ended 非对话行且幂等、路由参数互斥与 limit 钳制。
- 旧库迁移实测：构造无 `watermark` 列的 `zy_fleet_subs` 表 + 既有行，`createZhiyuStore` 打开后列已补上、旧行 `watermark=NULL`（下一轮静默基线）。
- 查询计划：翻页走 `sqlite_autoindex_zy_room_messages_1 (room_id=? AND seq<?)`；保留期走 `idx_zy_room_messages_kind_created (kind=? AND created_at<?)`。
- 清理脚本实测（种子库 5+3 重复行 + 1 行对话）：dry-run 报 `2 group(s)/6 row(s)`；`--apply` 删 6 留 2 报数 + 1 对话；二次运行 `nothing to do`。
- `npm --prefix web run typecheck` 绿；`npm run check:locales` 五语齐全；`biome check` 8 个改动文件无告警。

### 5.2 复核（2026-11-10 20:42，镜像 `sha-528eea6`，pod `platform-7bcdbc4bc4-rj8zq`）

- [x] 5.2a 复核完成（未到期，静默正确）：grep 命中 0、marker 6.69h < 20h、残留 0；证据如下四行，结论=「维持 5.2 已勾」
- 命令与命中：`kubectl logs <pod> -c platform --timestamps | grep "retention sweep"` → **命中 0 行**。
- 为何是 0 而不是故障：`zy_meta.retention_last_run` = `2026-11-10T06:01:18Z`（=14:01:18 +08），距今 **6.69 小时 < 20 小时 `minIntervalMs`** → `retentionTick` 返回 `ran:false` 且按设计不打日志。本 pod 20:06 启动，30 秒首轮 tick 已跑过（静默即正确）。
- 残留行（只读 dry-run 口径，30 天阈值）：**0 行**。ended 房 system/event 共 514 行，按年龄 `lt1d 41 / 1to7d 318 / 7to30d 155 / gt30d 0` —— 没有任何一行超过 30 天，所以"应删 0、实删 0"自洽。
- 跨 pod 证据：marker 由**更早的 pod**（14:01 那轮）写入、被当前 pod 读到并据此跳过，说明到期制是**库内状态驱动**而非启动锚定（旧实现「启动后 1 小时」在 20~35 分钟滚版节奏下永不触发，见 5.3）。
- 结论：5.2 维持已勾；本次复核未产生新的删除动作，属"未到期"而非"未生效"。

> **收尾（2026-11-10）**：本单 23/23 任务全勾，5.2 复核（5.2a）亦勾；无未完成项。
