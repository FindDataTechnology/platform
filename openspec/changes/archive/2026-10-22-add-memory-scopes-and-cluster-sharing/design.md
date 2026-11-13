# Design — add-memory-scopes-and-cluster-sharing

## Context

ADR-0030 D3（作用域与授权做成数据）的落地刀。as-built 关键事实（本刀开工前逐一核实）：

- **fd-memory**（`~/finddata/fd-memory`，git 仓）：四族令牌（auth.ts）；`namespaceParts` 把 `d/<packId>/<agentId>` 拍成根 `d-<packId>--<agentId>` + 单 `default` project——每 agent 一物理根；`scopeAllowsNamespace` 是 namespace 字符串等值/前缀特判；MCP 面八工具全部操作「本 namespace」，线协议无 namespace（mcp.ts:1-4）；mint 强制 `d/` 恰 3 段（http.ts:267）；`/hook` 面 person 专用、project 取 cwd basename；每根一个 RootDb（pages/fts/observations/hook_dedupe/handoffs），reindex 可从 wiki 重建。
- **runner**（paas agent-runner）：`#memoryMountToken` 以 `entry.name ?? entry.metadata.agentId` 拼 `d/<packId>/<agentId>` 铸 deployment 令牌（**优先级反了**——生产 tokens.db 实锤显示名坐标：`d/KkCi…/爬虫自愈修复 Agent` 与历史 `d/KkCi…/spider-heal` 同 agent 两坐标）；`#spawnPod` 显式不挂记忆（manager.js:1526-1532 注释指本刀）；pod 观测按成员经 `#memoryEventObserve` 归因。
- **registry metadata 实锤**：部署条目带 `agentId`（阿尔法哨兵 → `wx-alpha`）——坐标源已存在，只是 runner 读错字段。
- **packId 每部署唯一是结构性保证**：serving 面 registry 部署条目按 packId 单例（agent path `/packs/<packId>/<agentId>`，重部署覆盖同一部署；生产 21 个在役 packId 零跨部署重复）。因此 `d/<packId>` 不需要 owner 限定即满足跨 owner 隔离——「按部署者唯一性核实并钉死」的答案是不改布局键、把该不变量写进 spec 与 mint 守卫。
- **cell 集群回合**（server/cron-runner.js `runClusterTurn`）：373 行成员解析、~536 行 digest 落盘；`ctx.runtimeOwnerEmail` 可用；cell-memory.js 已有 person 令牌代铸 + 缓存（按 owner 落盘）。
- 顺序约束：`fix-memory-capture-p0` 已归档（d9b5eda4），本刀 agent-runner delta 以其同步后的主 spec 为基线（已满足）。

## Goals / Non-Goals

Goals 见 proposal。设计级边界：

- MCP 面的 `target` 是**相对选择器**（own/shared），绝不引入绝对 project/namespace 参数——「越权叫不出名字」不变量迁移为「越出 Grant 叫不出名字」。
- 平台缝（cell cron 编排）是**受信调用方**，允许在自己 root 内**点名 project**（经新 HTTP project 面）；MCP 面与 HTTP 面的分工即在此。
- 单写者假设维持：同根并发写者从 1（每 agent 一根）变为 N（同 pack 成员 + pod + cell），SQLite 默认 journal 模式下的写锁竞争是已知风险（见 Risks），v2 先实测。

Non-Goals（proposal 已列）：restricted ACL、owner 级只读开放、L2 蒸馏、向量检索、萬星 console UI、per-member MCP patch（成员私有挂载——pod 令牌先行的原因正是它可后补而 Grant 不动）。

## Decisions

### D1 令牌族与 Grant 表：pod 是第五族；授权全查表，特判只留 runner/platform

- `TokenKind` 增加 `"pod"`。`tokens.db` 新增表 `grants(token_id, scope_kind, scope_ref, mode, granted_at)`，PK `(token_id, scope_kind, scope_ref)`；`rw ⊇ r`。
- Scope 归属推导 `scopesForNamespace(ns)`：`d/<p>/<a>` → [agent `d/<p>/<a>`, pack `d/<p>`]；`d/<p>` → [pack `d/<p>`]；`u/<u>…` → [owner `u/<u>`]。鉴权 `allows(tokenId, ns, mode)` = 任一归属 scope 有满足 mode 的授予。
- 铸币默认授予（mint 时同事务写入）：deployment → agent rw + pack rw；pod → pack rw；person → owner rw；runner/platform 无数据授予。**回填**：服务启动 migrate 时对全部未吊销令牌 `INSERT OR IGNORE` 默认授予（幂等，族与 namespace 决定内容）。
- 特判保留仅两处：runner 的 capture-only `d/*`（capture 路由内）与 platform 恒拒数据面。deployment 的「恰一 namespace」由其默认授予自然表达，撤销 pack 授予即收窄到 agent 私有——**新共享模式零代码**。
- mint 面规则：runner 可铸 `d/` 的 2 段（→ pod）与 3 段（→ deployment）namespace；族由段数推导，不引入 kind 参数（少一个可伪造面）。platform 铸 person 不变。
- 备选「namespace 字符串特判每种共享模式」被否：proposal 引 ADR-0030 D3——那是 as-built 做不到共享的根因。

### D2 v2 磁盘布局：`d/` 镜像 `u/` 一根多 project；迁移以令牌库为坐标源

- `namespaceParts` v2：`d/<packId>/<agentId>` → 根 `d-<packId>`、project `<agentId>`；`d/<packId>` → 同根、project `shared`。`u/` 分支不变。project 段经 `safeSegment`（拒 `/`、`..`、空段；中文/显示名保留——生产 u/ project 已是 cwd basename，同理）。
- **迁移不反解目录名**：`d-<pack>--<agent>` 的 packId 是 base64url（可含 `-`，双 `--` 有真实概率），从目录名切分有歧义。坐标真源 = tokens.db 的 namespace（分隔符干净）。孤儿目录（无令牌对应）按保守解析搬迁并告警。
- 迁移脚本 `scripts/migrate-v2.mjs`（fd-memory 仓）：遍历 deployment 令牌 namespace → 计算旧根/新根 → `renameSync` 搬 wiki 树 + 每根 `reindexFromWiki`；目标存在则合并（文件级 rename，冲突即中止报清单）；旧根目录保留（重命名 `.v1-backup` 后缀而非删除）——验收后再人工清理。幂等：第二次运行时旧根不存在即跳过。
- 生产执行序：备份 PVC 快照 → 停 fd-memory（分钟级）→ 跑迁移 → 起新版本 → 验收 → 清 backup。回滚 = 旧镜像 + 反向 rename（backup 目录名还原）。
- 生产数据现实：6 个 d/ 根、总量 ~7MB（10-22 基线），分钟窗口绰绰有余。

### D3 MCP 面：target 相对选择器 + 读并集带 source + 按名寻址工具加 project 守卫

- 八个工具 schema 增加可选 `target`（enum own|shared）。成员令牌：own = 自己 project、shared = `shared` project；pod 令牌：默认 shared，显式 own → isError 带说明；person：own = default project（现状语义），shared 不适用（isError）。
- 读工具默认并集：query/recent/handoff_list 在 [own, shared]（或 pod 的 [shared]）project 间合并，每条带 `source`；显式 target 收窄单侧。实现层面 RootDb 增加按 project 过滤的查询参数（searchPages/recentPages/openHandoffs 现为全根扫描——同根跨 project 泄漏正是 v1 每根一 agent 掩盖的洞，必须一并修）。
- 写工具默认 own、`target:"shared"` 写共享区；`memory_handoff_begin` 共享区可带 `to_agent`（HandoffRow 增列，落 frontmatter；accept 仍 claim-once，认领者可以是任何持 pack 授予者——定向是归属标注不是 ACL）。
- **守卫**：`memory_read_page` 的 path 首段、handoff accept/cancel 的目标行 project，MUST ∈ 该令牌可访问 project 集，否则 isError/拒。这是 v2 共根后新出现的越界面（v1 物理隔离天然挡住）。
- Grants 实时性：每次 tools/call 重查 grants（令牌本来每请求重验，无缓存宽限纪律延续）。

### D4 平台缝 project 读写面：`GET/POST /pages`，自己 root 内点名 project

- 新 HTTP 面（http.ts）：`GET /pages?project=<id>&limit=` 返回该 project 最近页面（标题+更新时间+摘要）；`POST /pages` body `{project, title, body}` 写一页。鉴权 = 令牌 + `allows(tokenId, nsForProject, rw)`；person 经 owner 授予覆盖全 root project（集群 project 因此可达）；deployment/pod 只能点名自己可访问的 project。写落审计行。
- 这是 cell 集群两挂点的载体（D6），也是 distiller（后续刀）的写入口。与 MCP 面的分工：MCP = agent 相对选择器；HTTP = 平台缝受信点名。线协议仍无 namespace/root——project 在请求者自身 root 内解析。
- 备选「扩 /capture 带 project」被否：capture 是观测流（hooks 形状），digest 是页面，形状不同不混面。

### D5 pod 令牌族与挂载（runner）

- `#spawnPod`：按 `route.packId` 铸 pod 令牌（`d/<packId>`，2 段，label `pod:<childKey>`），缓存进既有 `#memoryTokens`；挂载行 append 进共享 `mcpServers`（与 mcpRows union 同处）；`memoryDiscipline: token ? MEMORY_DISCIPLINE : null`——纪律随挂载同生同灭的 p0 规则自然延伸到 pod。铸造失败 fail-open（照旧无挂载无纪律）。
- pod 成员观测：维持 `#memoryEventObserve` 按成员投 `d/<packId>/<agentId>`（归因到 agent scope，spec 新场景钉死「共享 namespace 下无成员观测」）。
- **agentId 优先级修正**：`entry.metadata.agentId ?? entry.name`（两处：`#memoryMountToken`、`#memoryEventObserve`）。registry metadata 已带 agentId（实锤），无需改部署链。改名后坐标连续；历史显示名坐标由迁移吸收（见 D2——生产 `d/KkCi…/爬虫自愈修复 Agent` 搬到 `wiki/spider-heal`？**不**——迁移以令牌 namespace 为准，该 namespace 的 agentId 段是「爬虫自愈修复 Agent」即显示名，搬过去 project 名就是它；只有重新部署后的新令牌才用 metadata.agentId。可接受：历史坐标是快照，新坐标从新部署起稳定）。
- ACP pod（compose-acp）同改动：共享 MCP 传递面 append 同一挂载行。

### D6 cell 集群回合两挂点（cron-runner + cell-memory）

- 新模块 `server/cluster-memory.js`：`clusterMemoryFor(env, ownerEmail)` 返回 `{ readShared(clusterId, limit), writeDigest(clusterId, title, body) } | null`——复用 cell-memory 的 person 令牌（同缓存文件）、走 D4 的 `/pages` 面；任一失败降级（返回 null / 记 warn）。
- 挂点①：`runClusterTurn` 成员解析成功后、成员执行前读 `project=<cluster.id>` 最近 ≤5 页 → 有内容则拼 `【集群共享记忆】…` 块 append 进成员任务提示（成员提示与 a2a 提示共用 job.prompt，一次注入全体生效；summary 综合提示不注入——成员输出已携带记忆影响）。
- 挂点②：digest 定稿后（summary 成败两分支汇合处、recordMessage 前后皆可）`writeDigest` 写回同 project；失败 warn 不判败。
- 开关 = 既有 `CELL_MEMORY_ENABLED` 全家（挂载、代铸、两挂点同生同灭）；`runtimeOwnerEmail` 缺失（无主上下文）时两挂点跳过。cluster.id 过 `safeSegment` 同款规范化做 project 名（dyn_* 天然安全）。
- 集群 project 与 pod 共享区是**两条车道**：`u-<owner>/wiki/<clusterId>`（cell 编排）vs `d-<packId>/wiki/shared`（pod 成员 MCP）。spec 各自钉住，不合并。

### D7 审计与管理面

- RootDb 新表 `writes(ts, principal, scope, page_rel, op)`：principal = `<kind>:<tokenId>`（无令牌材料）；op ∈ page_write / handoff_begin / handoff_accept / handoff_cancel / capture_batch。写入伴随主路径（try/catch 包裹——审计失败不阻断写入，warn 即可）。
- `/admin/report` POST：返回调用方 root 的 `{grants: 该 root 相关令牌授予, recent_writes}`；runner/platform 可带 `rootKey` 查任意 root（运维位），person 只能查自己。提案的「列出某 owner 的 scope/grant/最近写入」落地于此，不做独立 UI。

### D8 评测 v0（fd-memory/fixtures/eval/）

- 两份脱敏真实转录 fixture：spider-heal 集群回合（生产 trace 摘录）+ 一个 serving 回合。`run-eval.mjs`：临时目录起 Service → 按 fixture 注入观测/交接/页面 → 跑一组任务派生查询 → 输出交接召回率（期望交接是否进 top-k）与 project 隔离断言（成员查询不命中他人 project）。零 LLM、确定性、进 npm test 作为 verify 任务与 distiller 基线。

## Risks / Trade-offs

- [同根写者变多，SQLite 写锁竞争] → v2 上产后观察 `SQLITE_BUSY` 频率；必要时开 WAL（`PRAGMA journal_mode=WAL`——node:sqlite DatabaseSync 支持，一次性 pragma 进 migrate）。先不默认开：改动面小但要在迁移窗口一并验证，本轮观测、下轮翻默认。
- [迁移把生产唯一真源搬家] → 先 PVC 快照；脚本 dry-run 模式（打印计划不执行）；旧目录 `.v1-backup` 保留至验收；迁移后 `reindex` + eval 断言 + 人工 `memory_query` 抽查。
- [共根后同 pack 成员互读越界（read_page/handoff by id）] → D3 project 守卫为 MUST 场景；测试含突变（去掉守卫必须红）。
- [pod 令牌泄漏 = 整 pack 共享区可写] → 与既有 deployment 令牌同级风险（同是 runner 代铸、pod env 注入）；令牌可吊销且 Grant 可单独撤 pack 授予（ finer than v1）。
- [cron 注入把 stale 记忆喂给每个成员] → 注入块带页面时间戳；limit 5 页控制长度；空 project 不注入。
- [历史显示名 project 与新 metadata.agentId project 并存（同 agent 两段记忆）] → 接受为快照语义（迁移不融合、不重写）；distiller 刀的 reconcile 面可后续合并。台账记录该已知断档。

## Migration Plan

1. fd-memory 出片（含迁移脚本 + 新面，向后兼容读：**读路径不兼容 v1 目录**——服务升级与迁移必须同窗口）。
2. 生产：PVC 快照 → scale fd-memory 0 → Job/一次性 pod 跑 `migrate-v2`（dry-run 先行）→ 起新版本 fd-memory → 验收（eval + admin/report + 抽查 query）→ 清 `.v1-backup`。
3. runner-serving 滚动（pod 挂载 + agentId 修正生效；旧 deployment 令牌已被回填授予，继续可用）。
4. cell（platform 镜像）滚动：两挂点 + /pages 消费生效。
5. 回滚：fd-memory 回旧镜像 + 反向 rename backup；runner/cell 回旧镜像即回无 pod 挂载行为（令牌多铸无害）。

## Open Questions

（无——packId 唯一性、agentId 字段存在性、owner 身份来源三个开工前未知数均已对生产核实钉死。）
