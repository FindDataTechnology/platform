## Why

多 agents 管理需要集群成员之间共享记忆与互相交接，而 as-built 的记忆面做不到：namespace 恒为 `d/<packId>/<agentId>`、每 agent 一个物理隔离根、令牌恰一个 namespace、MCP 线协议刻意不带 namespace（`fd-memory/src/mcp.ts:2-4`），共享在模型里**不可表达**；fleet pod（同 pack 多成员共宿一个子进程、共享一份 MCP patch）路径因此根本不挂记忆（`agent-runner/manager.js:1472-1474`），集群成员今天在 agent 侧零记忆；cell 侧集群回合的 persona 成员共用 `u/<owner>` 单 project，无结构无归因。权限写在 namespace 字符串形状里，每种新共享模式都要改代码。ADR-0030 D3 定案：作用域与授权做成数据——Scope 对象 + Grant 表，令牌是 principal 身份；MCP 不变量（越权叫不出名字）保留，只加相对选择器。

## What Changes

- **Scope 与 Grant 模型**（fd-memory）：Scope 种类 `agent`（成员私有）/ `pack`（集群/pod 共享）/ `owner`（部署者名下）；`grants(token_id, scope_kind, scope_ref, mode r|rw)` 表；`scopeAllowsNamespace` 改为查 Grant；铸币时写默认授予（成员令牌 = 自己 agent rw + 所属 pack rw；pod 令牌 = pack rw；person = owner rw；runner / platform 不变）。既有令牌回填默认授予。
- **v2 磁盘布局**：`d/` 分支镜像 `u/` 的「一根多 project」——`d/<packId>` → 根 `d-<packId>`、project `shared`；`d/<packId>/<agentId>` → 同根、project `<agentId>`。跨 owner 物理隔离不变。既有 `owners/d-<pack>--<agent>/wiki/default/*` 一次性搬家到 `owners/d-<pack>/wiki/<agent>/*` 并 `reindex`（生产数据自 10-19 起、量极小）。**`<packId>` 按部署者唯一性在实施首步核实并钉死**（v1 既有暴露）。
- **MCP 工具增量**：新增可选参数 `target: "own" | "shared"`（相对选择器，非 namespace 名）；读工具（`memory_query` / `memory_recent` / `memory_handoff_list`）默认 own + shared 并集、每条带 `source`；写工具（`memory_write_page` / `memory_handoff_begin`）默认 own、`target: shared` 写共享；`memory_handoff_begin` 到 shared 可带 `to_agent`，accept 仍 claim-once——即 agent→agent 交接。pod 令牌无 own，默认即 shared。
- **pod 令牌族与挂载**（runner）：新增 `pod` 令牌族，`#spawnPod` 以 runner 令牌为整 pod 代铸、挂进共享 `mcp.patch.yml`（与 `mcpRows` union 同处）；pod 成员观测按 memberKey 归因到各自 agent scope。成员私有分区等 per-member MCP patch 后补——届时成员令牌替换 pod 令牌即可，Grant 不动。
- **agentId 改用 `metadata.agentId`**（现用 `entry.name` 显示名：中文/空格、改名＝换 namespace），随布局迁移一并处理。
- **集群回合两挂点**（cell）：`server/cron-runner.js runClusterTurn` 成员解析后读 `owner` 根下 `<clusterId>` project 的 shared 注入成员上下文；digest 落盘前把 digest 写回同 project。pack 声明式集群与动态集群（`dyn_`）同样处理。
- **审计**：`writes(ts, principal, scope, page_rel, op)` 表；admin API 列出某 owner 的 scope / grant / 最近写入。
- **评测 v0**：`fd-memory/fixtures/eval/` 放脱敏真实转录（spider-heal 与集群回合）+ 交接召回率跑分脚本，作为 verify 任务与后续引擎变更的基线。
- **明确不做**：`restricted` ACL scope（v3）；owner 级只读开放给 pack（v3，经 manifest 声明）；L2 蒸馏（`add-memory-distiller`）；向量检索（v2.2）；萬星 console 可见性 UI（随 distiller 一起，这里只给 admin API）。

## Capabilities

### New Capabilities

（无——Scope/Grant 是舰队记忆服务的核心语义，落在既有 `fleet-memory` 能力内）

### Modified Capabilities

- `fleet-memory`: 「记忆按 namespace 寻址且跨 owner 永不共库」→ 寻址单位细化为 Scope（agent / pack / owner），同 owner 根内按 project 分区，跨 owner 物理隔离不变；「令牌两族且每请求鉴权」→ 令牌四族 + pod 族，授权经 Grant 表而非 namespace 等值；「MCP 工具面按 namespace 收窄」→ 按 Grant 收窄、`target` 相对选择器、读并集带 source、线协议仍无 namespace；新增「每次写入可审计」需求。
- `agent-runner`: 「部署 agent 的工作记忆经平台缝代采与挂载」→ pod 运行时组合携带 pod 令牌挂载；pod 成员观测按成员归因；agentId 取 `metadata.agentId`。
- `scheduling-cluster-aware`: 「Cluster task execution and aggregation」→ 集群回合分发前读取、聚合后写回集群共享记忆（owner 根下按 clusterId 分区），记忆不可达时降级开放。
- `memory-federation`: 「cell 记忆挂载遵守组合与凭据纪律」→ person 令牌默认授予覆盖 owner 根下全部 project（含集群 project），语义由 Grant 表达。

## Impact

- fd-memory（`~/finddata/fd-memory`）：`auth.ts`（namespaceParts / scopeAllowsNamespace / grants）、`db.ts`（grants、writes 表）、`mcp.ts`（target、并集、source）、`store.ts`（多 project 读）、`http.ts`（mint 校验放宽到 2-3 段、admin 列表）、迁移脚本 + fixtures + 12→~20 单测；出片走 `fd-build-channel` 纪律。
- paas runner：`manager.js`（`#spawnPod` 代铸与挂载、agentId 派生、成员归因）、`memory-mount.js`；`memory.test`。
- paas cell：`server/cron-runner.js`（两挂点）、`cell-memory.js`（集群 project 选择）。
- 部署：fd-memory 镜像 + PV 上一次性迁移（停机窗口分钟级，先备份 PVC）；runner-serving 与 cell 镜像滚动；回滚 = 旧镜像 + 迁移脚本反向（保留旧目录副本直至验收）。
- 顺序：`fix-memory-capture-p0` 先归档；本 change 的 `agent-runner` delta 以其归档后的主 spec 为基线。`add-memory-distiller` 依赖本 change 的 Scope 与审计表。
- 风险：共享根 = 同 owner 成员共库——这是目的，不违反跨 owner 隔离；SQLite 并发写（DatabaseSync 无 WAL 配置）随写者增多需实测，必要时开 WAL。
