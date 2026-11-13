## Context

见 `proposal.md — Why`。设计只补三处必要背景：

- **写入路径现状**：`gateway/fleet-room-bridge.js` 的 `tick()` 由 `gateway/index.js:1071` 的 `setInterval(() => void bridge.tick(), FLEET_ROOM_BRIDGE_MS || 60_000)` 驱动，`tick` 是异步的（`sampleFleets` 走 HTTP 到 owner 自己的 cell，含 `registry.ensure` 与 15s 超时）；`diffOverview` 把「上次已流入的报数时刻」写在**本次样本对象**的私有属性上，基线随样本替换而丢。
- **数据形态**：`zy_fleet_subs` 是（room_id, fleet_id, fleet_name, owner_email, created_at）的订阅行；`zy_room_messages` 以 `(room_id, seq)` 为键、`visibility` 过滤私窗；读面只有 `after`，无 `before`。
- **迁移纪律**：cell 库的 schema 走 cell 台账/`initDb` 的迁移入口，**禁裸 ALTER**（裸 ALTER 抛错会把整库置为 disabled）；新列必须在真实 cell 库副本上跑一次 `initDb` 验证。

## Goals / Non-Goals

**Goals:**
- 让「同一事件至多流入一次」成为**不依赖进程内状态**的性质：重启、样本替换、叠跑、多实例都不重发。
- 让异步采样在结构上不可能重叠。
- 让「房间结束」成为一个真实的闸（停止流入，但保留订阅关系），而不是只在 UI 上变灰。
- 让长历史可双向回读、首屏不重放全量。
- 给已结束空间的非对话行一条有界、幂等、可审计的出口。

**Non-Goals:**
- 不做跨实例的分布式锁（水位线 + 事务幂等已足够；多实例并发只允许"多写一次判定、至多落一行"）。
- 不改回合路由、熔断、计费、私窗投递的语义。
- 不做房间整删、不做对话内容归档到冷存储（保留期只碰 system/event 行）。
- 不清理存量重复行以外的一切历史数据（清理配方独立执行、需人工确认）。

## Decisions

**D1 — 水位线落库在 `zy_fleet_subs` 行内，用一列 JSON。**
每个（空间, 团队）订阅自持 `watermark`（TEXT，存 `{reportAt, decisionsCount, abnormalCount}`）。选它而不选独立表：订阅行本来就是该关系的唯一凭据，水位线与订阅同生共死（订阅删除即水位线消失，恰好语义正确）；不选独立表的原因是它需要额外 join 且要在删订阅时额外清理。不选"内存 Map + 定期 flush"的原因：重启丢窗口正是本 bug 的形态。

**D2 — 落行与推进水位线在同一事务里，且"先算后写"只做一次。**
`store` 暴露一个 `fleetSubConsume(roomId, fleetId, items, render)` —— 在一个 `db.transaction` 内：读当前水位线 → 过滤出真正的新事件 → 按既有频控渲染出行 → 插行 → 更新水位线。把"判定"和"写入"合成一次原子动作，从根上消灭「判定用 A、写入用 B」的窗口。频控计数器（每窗口 10 条 + 1 条合并）仍留在进程内——它只影响"呈现密度"，丢了最多多发一条合并行，不会重发同一条报数。

**D3 — 采样改成自调度循环，`setInterval` 退场。**
`tick()` 结束后 `setTimeout(loop, interval)` 再排下一轮（`unref()` 保留），并保留一个 `running` 布尔兜底（手工 `tick()` 调用如测试、运维触发时同样受闸）。这样"叠跑"不是被检测，而是不存在。备选（信号量/队列）更重且修不到"两次 tick 用同一份陈旧基线"的语义问题。

**D4 — 结束房闸放在订阅读取处（一次 join），不放在渲染处。**
`fleetSubsAll()` 改为 `zy_fleet_subs LEFT JOIN zy_rooms` 带回 `status`，`tick` 直接跳过非 active 的订阅。选 join 而非逐订阅 `roomGet`：一次查询 vs N 次；且"订阅视图自带房间状态"对后续调用者更诚实。订阅行不删（spec：保留），水位线在这期间不动——所以房间恢复后不会补发断流期的积压，只会从水位线之后的新事件续流。

**D5 — `lastSample` 变成按 owner 的 Map，且降级为纯优化。**
`lastSampleByOwner: Map<email, sample>` 修掉"多 owner 时基线互相覆盖"的既有缺陷；但即使它为 null（重启后首轮），正确性也不依赖它——首轮要么按水位线静默基线，要么按水位线补发，二者都不会重复。`diffOverview` 不再在样本上写 `_bridgeLastReportAt`。

**D6 — 读面加 `before` 与 `tail`，`after` 语义原样保留。**
`store.messagesBefore(roomId, beforeSeq, {viewerMemberId, limit})` → `WHERE seq < ? ... ORDER BY seq DESC LIMIT ?`，返回前反转成升序；`store.messagesTail(roomId, n, ...)` 复用同一实现（`before = ∞`）。HTTP：`GET /rooms/:id/messages?after=&before=&tail=&limit=`，`limit` 默认 200、上限 500，`tail` 与 `before` 互斥，`after` 与 `before/tail` 互斥（同时给 = 400）。对既有调用者的兼容：**不带参数**仍等价于 `after=0`（脚本/测试不受影响），但上限从 1000 降到 500——这是唯一可观察的收紧，需要在发布说明里点名。前端首屏改为 `?tail=200` 立即渲染，然后 `new EventSource('/events?after=<tail 最大 seq>')`。

**D7 — 保留期只碰「已结束房 × 非对话行」，默认开、可关。**
`store.pruneRoomSystemRows({roomIds?, olderThanMs, dryRun})`：`DELETE ... WHERE room_id IN (ended) AND kind IN ('system','event') AND created_at < ?`，返回 `{matched, deleted}`；`dryRun` 只报数。驱动：一个日频 sweep（与既有 idle sweep 同形态，`unref`），阈值 `ZHIYU_RETENTION_DAYS`（默认 30），`ZHIYU_RETENTION_SWEEP=0` 关闭。选"只非对话行"而非整房 TTL：对话与私窗是产品资产，删它们需要显式动作与用户裁决；选"默认 30 天"而非无限期：本 bug 的另一半就是"没有出口"。

**D8 — 存量清理是一次性脚本，先报告后执行。**
`scripts/cleanup-zhiyu-duplicate-bridge-rows.mjs`：`--dry-run`（默认）按 `(room_id, json_extract(meta,'$.at'), json_extract(meta,'$.bridge'))` 分组，保留 `seq` 最小的一行，报告每组 `kept/dropped`；`--apply` 才删，且只删 `bridge` 为 `report` 且房间已结束的行。不入自动 sweep。

## Risks / Trade-offs

- [裸 ALTER 把整库 disabled] → 新列只经 cell 台账/`initDb` 迁移入口；发布前在真实 cell 库副本上跑一次 `initDb` 并核对 `PRAGMA table_info(zy_fleet_subs)`。
- [`limit` 上限从 1000 收紧到 500 打破某个脚本的"一次全读"] → 先 grep 全部调用点（`scripts/test-zhiyu-*.mjs`、web、e2e），逐点确认；确有需要的调用改走 `before` 翻页并在变更说明里点名。
- [SSE 尾部起播让"打开即见全部历史"的期望落空] → spec 已把它写成显式行为；界面上补一个"向上翻页/载入更早"的入口，避免用户以为历史丢了。
- [水位线事务把渲染拉进 store 层] → 渲染函数以参数注入（`render` 回调），store 不做文案决策；若嫌耦合，退化为"store 提供 `fleetSubConsume(fn)` 事务包装器"。
- [保留期删掉 system 行后 `seq` 出现空洞] → 游标语义不依赖连续性（`seq >` / `seq <`），空洞安全；但"翻到首行累计行数等于可见行总数"的断言要按当前库内行数而非历史总数写。
- [多实例并发] → D2 的事务 + 唯一性副作用只在"两实例同时读到同一水位线"时发生；此时两边都可能判为"新"，但落行在水位线上的比较需再校验一次（事务内 `WHERE watermark = <读到的值>` 条件更新，失败即放弃本轮），以此保证至多一行。

## Migration Plan

1. 改 schema（`zy_fleet_subs.watermark`）→ 在本机 cell 库副本跑 `initDb` → 核对列存在。
2. 发布（单镜像滚版，`RELEASE` 线）：自调度 tick + 水位线事务 + 结束房闸 + 分页读面（前端与网关同镜像）。
3. 发布后观察 10 分钟：`zy_room_messages` 中 `bridge:"report"` 的新增速率应归零（该房已 ended）；`bridge:"merged"` 不再增长。
4. 先跑清理脚本 `--dry-run` 出计数报告 → 用户确认 → `--apply`。
5. 回滚：新列向后兼容（旧代码忽略它），回滚镜像即可；清理脚本不可逆，故必须在 `--dry-run` 计数与用户确认之后才执行。

## Open Questions

- 保留期默认 30 天是否合适（ended 房的桥事件行价值只有"当日可读"）；可先用 30 天观察一轮，不改 spec 语义。
- 演示房是否需要"永不清理"的豁免位（`zhiyu@finddatatech.cloud` 持有的公开房是营销资产）；倾向用"进行中 + 不结束"来自然豁免，不引入例外机制。
