# fix-zhiyu-room-lifecycle-and-bridge-watermark

## Why

生产索引（`/data/cells/zhiyu.db`，2026-11-10 实测）里有一间**已结束**的房间 `zy_1ad879f94b7f3248e3`（"zhiyu桥修复复验 2026-11-07"）挂着 1155 条消息，其中 **1018 条是同一条报数**——`「工单分诊集群·试跑」分诊岗 报数：工单分诊补跑：拉取 account 7 工单`，`meta.at` 自 **2026-11-08 07:38 起冻结不变**，却仍以约 2 分钟一条的节奏追加（最后一条 seq=1155，2026-11-10 02:16:29）。频控本身是活的（同房有 75 条 `bridge:"merged"` 合并行 = 10 条 + 1 条合并/小时），所以问题不在"限额"，而在**去重水位线没有持久落点**：`gateway/fleet-room-bridge.js:327` 把 `_bridgeLastReportAt` 记在每次 tick 新取的样本对象上，样本一换水位线即丢，同一条报数被反复判成"新报数"。叠加两个结构性缺口让这条坏账能一直挂着：

- `tick()` 只看 `store.fleetSubsAll()`，不查房间 status——房间结束不等于订阅断流（spec 未覆盖此态）。
- `setInterval(() => void bridge.tick())`（`gateway/index.js:1071`）对异步 `tick()` 无重入闸，慢样本（`sampleFleets` 是 HTTP + `registry.ensure`，15s 超时）可叠跑，两个 tick 会拿同一份陈旧基线各写一次。

同一间房还暴露了读面的边界缺失：`GET /api/zhiyu/rooms/:id/messages` 硬顶 1000 条且只有 `after` 没有反向翻页（`gateway/zhiyu/index.js:807`），SSE 每次打开从 seq 0 全量重放（`web/src/pages/ZhiyuRoomPage.tsx:240` 的 EventSource 不带 `after`），`zy_room_messages` 无保留期（store 只清 widget nonce）。这间房已经 1155 行、超过读取上限。**为什么是现在**：房虽 ended，写入仍在进行，坏账每小时约 +12 行且没有自愈路径；再等只会让首屏重放更慢、把"演示房"之外唯一的真实数据也变成噪声。

## What Changes

- **事件去重水位线落库**：每个（房间, 舰队）订阅持有一条持久水位线（`zy_fleet_subs` 增列或同构行），报数/拍板/健康的"是否新"判据只认该水位线，不再依赖样本对象上的内存属性；进程重启、样本替换、叠跑 tick 均不得重发已知事件。
- **tick 单飞**：同一实例内 `tick()` 加轻量重入闸（进行中则跳过本轮），叠跑不再产生双写；跨实例以水位线为准（幂等）。
- **结束房断流**：tick 追加房间 status 闸——房间 ended 的订阅 SHALL 停止流入事件（订阅行保留，不静默删除）；房间重新活跃不得补发断流期事件，SHALL 以水位线为准从当前态续流。
- **读面分页**：消息读接口支持 `before`（反向翻页，按 seq 降序窗口）与显式 `limit` 上限，`after` 语义不变；首屏打开 SHALL 从尾部取最近窗口而不是 seq 0 全量重放（EventSource 带 `after`），向前翻页只走 REST。
- **保留期**：`zy_room_messages` 按房间状态与年龄做有界保留（ended 房间超过保留期的 system/event 行可归档或删除；human/agent 行与整房删除策略另行确认），并提供一条可复跑的清理入口（幂等、只报数不改语义）。
- **存量收口**：对已发生的重复行给出一次性清理配方（按 `room_id + meta.at + bridge:"report"` 去重保留首行），执行前先出计数报告，不自动删。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `zhiyu-room`：消息流新增**反向翻页与尾部起播**的要求，并新增**房间消息保留期**要求；`after` 语义与既有 SSE 重连语义保持逐字节兼容。
- `fleet-room-bridge`：事件流入新增**持久去重水位线**、**tick 单飞**与**房间结束时断流、恢复时不补发**的要求；既有频控（10 条 + 1 条合并/小时）语义不变。

## Impact

- 代码：`gateway/fleet-room-bridge.js`（tick / diffOverview / 水位线）、`gateway/zhiyu/store.js`（订阅水位线列、`messagesBefore`、保留期清理）、`gateway/zhiyu/index.js`（messages 分页参数、SSE 起播点）、`web/src/pages/ZhiyuRoomPage.tsx`（首屏尾部起播 + 向前翻页）、`web/src/pages/ZhiyuEmbedPage.tsx`（同源起播）。
- 数据：`zy_fleet_subs` 增列（需与 `cell-ledger` 迁移纪律协同，禁裸 ALTER）；`zy_room_messages` 只增读取索引，不删列。
- 测试：`scripts/test-zhiyu-rooms.mjs`、`test-zhiyu-store.mjs`、`test-zhiyu-route-assembly.mjs`，新增 bridge 水位线/断流用例；`fleet-room-bridge` 现有 3 条 requirement 的脚本断言需回归。
- 非目标（本单不做）：失败事件的文案透明度（`agent_failed` 的 `content` 为空、原因只在 `meta.reason`；embed 面通用话术）、演示房 4 个 `A2A HTTP 405` 席位的体检、官网"两张席位"口径（O6）、`frame-ancestors` 允许 `http://` 源（O1）、以及真实使用转化（D 线）。这些各自单独立项。
