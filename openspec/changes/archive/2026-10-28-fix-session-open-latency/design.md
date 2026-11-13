## Context

「打开历史对话慢」的三段实测（生产，2026-10-28）：

| 段 | 读数 | 结论 |
|---|---|---|
| 客户端渲染 | 46 篇 → 1659 节点 / 7.5KB 文本 / `JSON.parse` 4ms / 无 long task | 不是瓶颈 |
| `GET /api/fleets` | 2.8s（冷启 13.6s），同期 `/api/voice/status` 等全部被顶住 | 事件循环阻塞 |
| 会话切换 WS | 空闲 1204ms vs 轮询在飞 3911ms（同一会话、同一 1.03MB 载荷） | 被上面的阻塞顶住 |
| 首帧载荷 | 1.0–1.35MB；`blocks` 占 99.2%；可见文本合计 8.5KB | 传输是主成本 |
| 载荷 vs 往返 | 13.7KB → 790ms；1.17MB → 3896ms | 随字节线性 |

N+1 分解（在生产 cell 数据的副本上跑）：60 个岗位的 catalog 合并 1813ms、岗位 DB 读 101ms、cron 列表 0ms。即 **合并占 90%+**。

## Decision 1：每请求一份目录快照，而不是给 `merged()` 加全局缓存

选项：

- (a) 全局缓存 `merged()` + 精确失效。否决：`merged()` 的输入横跨注册表快照、`installed_packs`、`user_presets`、`extension_configs`、`custom_skills`、`agents.json`、云端目录；任何一个写入路径漏了失效，就会让 `resolveTarget` 把活着的岗位判成「待补岗」→ 舰队误暂停。这个 blast radius 与收益不成比例。
- (b) **每请求一份快照**（采纳）。请求内的目录本来就该一致：现在同一请求里 60 次合并可能读到 60 个不同版本，改成一份反而更正确；而且请求结束即丢弃，跨请求永远新鲜。
- (c) 只修列表路由。否决：`/overview`、`/owner/board`、`/:id`、`/:id/cockpit`、草稿校验/apply、catalog 变更后的 reconcile 都是同一形状，留着就是下一个 2.8s。

实现：`catalog.mergedView()` 一次 `merged()` → `{ chatAgentEntries, agentEntry(id) }`；`resolveTarget(member, view = null)` 用 view 时不再碰 catalog；新增 `rosterResolver()`（`createFleetRoutes` 内）每请求造一份快照，并让 `taskIndexFor(fleetId, jobs)` 复用同一份 `cron.listJobs()`。测试注入的 `ctx.fleetTargetResolver` 原样穿透（第二参数被忽略），所以既有测试语义不变。

## Decision 2：名册行补 `openDecisions`，而不是删掉侧栏轮询

侧栏 `fleetOpenDecisions` 从 `GET /api/fleets` 的行里 reduce `f.openDecisions`，而该路由从未返回这个字段（只有 `/api/fleet-architect/fleets` 有）→ 角标恒为 0、永不渲染，60s 轮询纯空转。两条出路：

- 删轮询 + 删角标：把 decision-lane 刀3 交付的「待拍板」角标变成死代码，是产品倒退。
- **补字段**（采纳）：`db.countOpenDecisions(fleet.id)`，走 `idx_decision_items_fleet_state` 索引，21 支舰队 = 21 次索引计数（微秒级）。前端 `FleetRow` 早就把 `openDecisions` 声明为可选字段，服务端补齐即可。

## Decision 3：WS 用 permessage-deflate，而不是裁 blocks / 降窗口

- **裁 `blocks`**：UI 默认折叠「执行了 N 步」，但展开要看工具输出；服务端裁剪 = 永久丢数据，除非再加一个按需拉取端点 + 客户端改动（协议变更）。本批不做。
- **降窗口 N**：按字节算，这个会话 50 条就 1.3MB（中位数 23KB/条），降到 25 条只省一半，且直接减少用户一眼能看到的上下文。
- **permessage-deflate**（采纳）：无损、浏览器原生、客户端零改动、无协议变更。网关 `proxyUpgrade` 是裸 socket 双向 pipe，扩展协商在浏览器↔cell 端到端完成（`forwardedHeaders` 只剔除 hop-by-hop，`sec-websocket-extensions` 原样透传），所以压缩帧穿过网关不受影响。
  - `threshold: 1024`：小帧不建 zlib 上下文（CPU/内存都不花）。
  - `clientNoContextTakeover` / `serverNoContextTakeover`：每帧独立上下文，避免长连接累积窗口状态拖内存；代价是压缩率略低，对 1MB 级 JSON 无感。

## Risks

- 压缩 CPU：1MB JSON 单帧压缩约 10-20ms，一次性成本，且换来 1MB→百 KB 的传输。可接受。
- 每连接 zlib 上下文约数百 KB：聊天 WS 终结在**每用户 cell 进程**（连接数很少），不是共享的网关进程；no-context-takeover 进一步压低驻留。
- 快照一致性：同一请求内所有岗位看到同一份目录——比现状（60 份）更一致；跨请求不缓存，所以 pack 安装/预设变更下一请求即生效。