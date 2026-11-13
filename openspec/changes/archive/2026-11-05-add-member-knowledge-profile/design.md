# Design: add-member-knowledge-profile

## Context

见 proposal.md - Why。代码核实过的现状约束：

- 硬前置 add-agent-memory-foundation 提供：一等 metadata + 结构化筛选、owner oversight、root_owner 绑定、platform 代铸 deployment 令牌。本单全部消费、零协议新增。
- 既有 person 令牌 lane（cell-memory.js：一人一枚磁盘缓存 0600、`u/<ownerEmail>`）在 chat 主聊天面继续用——本单只动舰队成员车道，两 lane 并存不合并。
- fleet capture 现状：`server/fleet-memory.js` 单文件承载写读（`f/<fleetId>` project、标题前缀编码、相关性 digest），capture 走 `ctx.fleetMemoryCapture` fire-and-forget seam。
- 挂载单点纪律有建制先例：knowledge-memory-surface 的 spike 实证挂载链已存在（`server.js#seedStartupMcpConfigs` → extensions 库 → dsh 桥 writeMcpPatch），且「路径增长必漏」是真机 A/B 铁证——本单参数化必须落在同一收敛处。
- 文档边界已有服务端强制（document-library-tools 的集合过滤 + 越界报「不存在」），本单复用，不新造边界层。
- 纪律文本单一来源模式已有（memory-discipline.js 双面共享字符串）。

## Goals / Non-Goals

**Goals**：成员独立记忆（own/shared 分流）、knowledge profile 设置面与物化编译、文档运行时绑定、注入合一、经验沉淀纪律。全程 fail-open、capture 零 LLM。

**Non-Goals**：不动 chat 主聊天 person lane；不做跨 agent pull-read（进阶层）；不做记忆继承/世代（进阶层）；不改 library 检索算法本体；不做 profile 的租户间共享语义。

## Decisions

**D1 · 令牌铸造复用 platform seam，缓存沿用磁盘一人一枚模式。**
备选：给 cell 发 runner 式铸造权自铸——否决，多一个令牌族进入运行时上下文，越界面扩大。落法：cell 以既有 platform token 调 `/admin/mint`（deployment），令牌缓存 `cell-memory-tokens/d-<packId>-<memberId>.json`（0600、重启稳定、换防不换）；铸造失败计数重试，不阻塞物化（spec 降级开条款）。

**D2 · 五类事实的 own/shared 映射表收敛在 fleet-memory.js 单点。**
报数摘要（turn）→ own（岗位私有产出）；自身健康迁移（health）→ own；拍板产生/裁决（decision-*）→ shared（团队事实）；换防（swap）→ shared。映射硬编码于 capture 构造处并附注释钉 spec 条款，不做配置化——五类是 spec 钉死的封闭集合，配置化只会引入第四种口径。

**D3 · effective profile 是纯函数：蓝图默认 ⊕ 部署覆盖。**
单函数计算有效 profile（memory 开关/scope/预算/文档集），三链（schema 校验、试跑、物化编译）与运行时挂载全部只消费它；覆盖留痕走既有部署设置存储。备选：物化时把结果烧进部署记录——否决，运行时改文档集就要重铸，与「即时生效」条款冲突。

**D4 · 挂载参数化的落点 = mcp 配置生成处，供给门补边界断言。**
fd-memory MCP 行从「部署统一一行」改为「按 member 的令牌 + profile 生成」；文档边界参数随 profile 传入既有 library 工具过滤链。多路径一致性以回归断言钉住（cron/手动/房间三路径产 patch 对比），防未来路径增长破坏单点。

**D5 · 过渡期注入源 = own ∪ shared ∪ 存量 f/（回填后可筛），f/ 零新写自然衰减。**
地基单回填给存量 f/ 页补了 metadata，结构化筛选可直达；f/ 不再有新写入，数据量只减不增，无需淘汰机制。备选：一次性搬移存量页到新分区——否决，改写存量违反永不删页纪律且无收益。

**D6 · 统一预算梯子 = 记忆段（own→shared 顺序）→ 文档命中段，逐档截断标注。**
记忆优先于文档：经验是消化过的、文档是原料，且记忆段带层与日期标注对回合更关键。截断沿既有纪律（标注、不挤掉下级报数段），预算值取 profile 注入预算（缺省 = 现行默认）。

## Risks / Trade-offs

- [fleetContext 组装路径多（fleet-context.js / fleet-chat-context.js / 房间）] → D4 单点 + 断言；任何新路径先过供给门。
- [deployment 令牌泄漏面 = 每 member 一枚] → 令牌只进 cell 数据根（0600），从不进 prompt/上下文；吊销与轮换走 fd-memory 既有令牌面（oversight 下 owner 可见）。
- [双轨期检索结果体量上升（f/ 存量 + 新分区）] → 结构化筛选走索引；f/ 页随时间在预算竞争中自然衰减。
- [知识段使蓝图 diff 噪音上升] → diff 链对 knowledge 段做语义化展示（集合名而非原始 JSON），随本单实现。

## Migration Plan

1. 铸造与缓存（降级开，无行为变化）→ 2. capture 分流 + metadata 写法（f/ 停写切换点）→ 3. profile schema/管理面/编译 → 4. 挂载参数化 + 断言 → 5. 注入合流与统一预算 → 6. 纪律文本。部署次序：**add-agent-memory-foundation 先上产**（协议依赖）；回填命令在切流前于生产跑一次。回滚：步骤各自独立；capture 分流回滚 = 恢复 f/ 写入（存量新分区保留不删）。

## Open Questions

- 万星 console 侧部署成员（rootKey lane 差异）是否同吃本单挂载——**已实证（本单实施期）**：agent-runner 侧早已有 per-member 挂载件（`agent-runner/memory-mount.js` 的 `memoryNamespaceFor` = `d/<packId>/<agentId>` registry metadata 坐标 + `dshMemoryMount`/`acpMemoryMount`），runner carrier 天然同吃；本单新增的是 CELL carrier 的等价物。

## 实施期架构裁决（补记）

**D7 · cell carrier 的 per-member MCP 挂载 = worker-slot 私有 patch。**
实施期发现 cell 是单子进程 + 共享 mcp patch（成员回合 = 同子进程里的 per-session preset），MCP 挂载按子进程不按会话——spec 里「按 member 参数化挂载」在主链上结构性不可达。落法：worker 池每 slot 生命周期钉死一个 persona，因此 per-persona 私有 mcp patch（`writeMemberMcpPatch`，同一 writer 组合后做两处外科覆写：fd-memory 行换成员 deployment 令牌、library 行注入 LIBRARY_COLLECTIONS env）是天然落点；串行主链（TASK_WORKER_MAX=0）保持共享 patch（人根挂载）逐字节不变，成员身份由平台缝（capture/digest per-member 令牌）强制——降级模式如实记录，不用假绿遮。fail-open：compose 失败回落共享 patch。

**D8 · 令牌分层：成员私有记忆走平台缝，MCP 写走成员令牌（worker 池）或人根（主链）。**
capture/digest 全部经 per-member deployment token（`d/<fleetId>/<memberId>`，fleet 即部署；shared 分区也经成员令牌写——person token 的 "shared" 会误落 owner u/ 根，这是实施期抓出的语义陷阱）。管理面 PUT /knowledge-profile 写入即失效 per-persona patch 缓存——文档集增删下一回合生效，无需重铸。

**D9 · 经验沉淀纪律进 MEMORY_DISCIPLINE 单一来源**（双面共享字符串），成员读文档 → memory_write_page 落自己分区带出处。
