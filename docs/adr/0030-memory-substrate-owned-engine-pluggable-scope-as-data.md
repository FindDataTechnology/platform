# ADR-0030: 记忆底座自有、蒸馏引擎开源可插拔、作用域做成数据

- 日期：2026-10-22
- 状态：Accepted（方向经用户拍板；实施经三个 change：`fix-memory-capture-p0` → `add-memory-scopes-and-cluster-sharing` → `add-memory-distiller`）
- 关联：`docs/memory-architecture-v2.md`（本 ADR 的展开与路线图）、`docs/memory-and-stats-plane-explore.md`（10-19 底稿，D1-D6 决策的前身）、archive `2026-10-22-add-fleet-memory-v1` / `2026-10-21-add-memory-federation-v1`（as-built 底座）、CONTEXT.md「工作记忆」「交接」词条

## 背景

记忆面 v1 四切片已于 2026-10-19 全部上产（本地试点 → fd-memory 舰队服务 → 消耗统计 → 联邦）。用户 2026-10-22 把「支撑多 agents 管理的记忆系统」定为核心中的核心，要求做到最好且后续可迭代，并倾向「开源有就拿开源改」。

as-built 的多 agent 现状：namespace 恒为 `d/<packId>/<agentId>`、每 agent 一个物理隔离根、令牌恰一个 namespace；fleet pod（同 pack 多成员共宿一个子进程）路径**不挂记忆 MCP**（`agent-runner/manager.js:1472-1474`），成员只有平台单向代采；persona 却注入了「已挂载 fd-memory，请调 `memory_handoff_begin`」的纪律文案。即：集群成员今天在 agent 侧零记忆。

同日对腾讯两个项目做了代码级尽调（TencentDB-Agent-Memory ~25 万行 TS、Hy-Memory ~8 万行 Python），并横评了 13 个开源记忆项目（mem0 / Letta / Zep-Graphiti / LangMem / MemOS / Cognee / Supermemory / MemoryOS / A-MEM / ai-memory 等）。证据摘要见架构文档附录。

## 决策

1. **底座自有：fd-memory 保留并演进，不以任何开源整产品做多 owner 隔离底座。**
   尽调证明这一层没有现成品：TencentDB-Agent-Memory 的 team 之上无租户层、隔离是单库 ACL 过滤且「字段缺省＝不收窄」（`core/store/isolation.ts:27-45`）、`system_admin` 全知、proxy 鉴权默认可关、全仓零有效测试；Hy-Memory 是进程内 SDK、无多租户；MemOS 的 MemCube ACL 最完整但自托管绑 Neo4j+Qdrant；Letta 的 V1 server 已退役；Zep/Graphiti 参考服务器明示无鉴权。付费 owner 之间的隔离与授权是商业面，必须由我们持有。fd-memory 1.2k 行、12 单测 + e2e、markdown 真源、索引可重建——是可演进的尺寸；25 万行 fork 是迭代的反面。
   否决「整体换底」：跨 owner 退化为 ACL、必需 LLM 进写路径、代理进 LLM 热路径（记忆挂＝全舰队断）、OKF 联邦线重做。

2. **引擎开源、可插拔：L2 蒸馏经 Distiller 契约接入，首选 Hy-Memory working 场景抽取器。**
   `CodingMemoryExtractor.extract()` 是纯函数（`hy_memory/coding/extractor.py:785-816`）：输入 OpenAI 格式 messages，输出事实草稿与经验草稿，不碰存储；reconcile 的 prompt 构造与 ops 解析亦模块级可导入；依赖只有 stdlib + openai；提示词中英双语自动路由。它作为无状态 sidecar 跑在词元 LLM 车道上，产物写回我们的 OKF 页型。备选：mem0 单遍抽取、自研启发式、（远期）graphiti 时态图。专训模型 Hy-Memory-30B-A3B（Apache-2.0）可选不必需——官方自报通用强模型只差 1-2 分。
   否决「TencentDB memory-core 当引擎」为默认：可行但要背 25 万行，仅作 S1 不过门时的备选。

3. **作用域与授权做成数据：Scope 对象 + Grant 表，令牌是 principal 身份而非 scope 本身。**
   Scope 种类：`agent`（成员私有）、`pack`（集群/pod 共享）、`owner`（部署者名下）、（v3）`restricted`（ACL）。Grant = (principal, scope, mode r|rw)。默认授予：成员令牌 → 自己 agent rw + 所属 pack rw；pod 令牌 → pack rw；cell 集群回合编排者 → owner 下 cluster project rw。读＝own + shared 并集带 source 标签，写默认 own，handoff 打到 shared 即 agent→agent 交接（claim-once 原语不改）。
   **MCP 线协议仍不带 namespace 参数**（越权叫不出名字的不变量保留），只增相对选择器 `target: own|shared`。store-root 按 owner 物理隔离不变——跨 owner 永不共库。
   取法：MemOS「读集合/写集合」、Letta「attach」、ai-memory「项目共享 + 私有交接」。
   否决「继续用 namespace 字符串形状当权限」：每种新共享模式都要改代码，且已经把 pod 挡在门外。

4. **分层与写入纪律：L0/L1 零 LLM 热路径；L2/L3 后台、限额、永不覆盖只 supersede、全链溯源。**
   L0 观测（manager 代采 + /hook）与 L1 交接/笔记（agent 自写）保持零 LLM；L2 事实/经验由 Distiller 后台批写，每 owner 日 token 预算，计费真源仍是 sub2api；页型带 `sources[]`、`supersedes[]`、`confidence`、`expires_at`；L3 画像/schema 留 v4。
   取法：Graphiti 双时态、Hy-Memory supersede 链与 `details` 原文直取、TencentDB L0→L3 金字塔、Supermemory 过期遗忘。

5. **评测进 CI：真实转录 fixture + 三指标，每次引擎/检索变更必跑。**
   指标：交接召回率、接续成功率（下一会话不重推导）、事实 QA 正确率。基线取 spider-heal 与集群回合的脱敏转录。方法论借 Supermemory MemoryBench / mem0 memory-benchmarks（可换 provider 的跑分器）与 CMB（编码 agent 长程记忆，仅论文无代码）。没有评测的迭代是盲改。

6. **两个 P0 先于一切。**
   P0-1 `agent-runner/memory-capture.js` 单 `#namespace` 导致批次错投（38/63 行）——多部署共 manager 下 A 的观测可落入 B 的 namespace，是跨 owner 泄漏通道；P0-2 `#memoryObserve` 的 summary 只有「turn 结果 tokens ms」（`manager.js:946`），L0 无内容可蒸馏。先修这两处，再谈作用域与引擎。

## 后果

- runner：pod 路径补挂 pack 令牌；观测形状升级为工具名 + 参数摘要 + 结果摘要 + 意图摘要（脱敏前置）；`agentId` 改用 `metadata.agentId`。
- cell：`cell-memory.js` 的 `discipline` 文案接上消费者；集群回合在 `server/cron-runner.js runClusterTurn` 的分发前/聚合后两挂点读写 pack shared。
- fd-memory：`namespaceParts` 的 `d/` 分支镜像 `u/`（根＝pack、project＝agent 或 shared）；tokens 表增 grants；MCP 工具增 `target`；新页型 fact/experience；Distiller 读写缝；审计列。既有 `owners/d-<pack>--<agent>/` 根一次性搬家 + `reindex`（生产数据自 10-19 起、量极小）。
- 萬星 console：部署者可见自己的 scope（v2.1 起）。
- 明确不做：替换底座；memory-proxy 式 LLM 热路径拦截；任何跨 owner 可见性；在 L0/L1 引入 LLM。
- 10-19 底稿中的 D1-D6 继续有效，本 ADR 只在 D2（拓扑）上把「双 namespace」细化为「Scope + Grant」，在 D6（L2 排最后）上把引擎选型定为可插拔契约。
