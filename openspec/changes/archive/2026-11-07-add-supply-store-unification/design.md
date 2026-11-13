# Design: add-supply-store-unification

## Context

三个存储事实决定本设计：

1. **谦面 gateway（facet 应用，3200）**的 packs 存储是 better-sqlite3 单文件库（`gateway/packs.js`），pack 真源；W1 后它已是五物种目录 API 族的宿主。
2. **registry k8s 栈**（mcp-registry ns，cheap-8 hostNetwork）三 pod：registry（API+控制器）、mcpgw（网关 nginx）、auth-server（M2M/token），登记数据在独立 Mongo（`mcp_registry.mcp_servers_default` 等，2026-11-04 对账 28 条活册）；网关 nginx location 由 Mongo 条目驱动渲染，健康探活与 tool_list 快照由 registry 控制器周期刷新。
3. **壹座**已切 `FACET_CATALOG_URL`（registry-bridge.js「facet 模式」），凭据流走 registry API（credential_ref、per-line 分派、M2M token）。

约束：ADR-0015（registry 软件/域名/部署不变）；registry 是全网关上游，停写窗口稀缺；「Mongo 直补」类手工操作在生产有历史惯性，必须有结构性替代物否则会复发。

## Goals / Non-Goals

**Goals:**
- skill/MCP 登记记录物理上只剩一份（脊柱 SQLite），写入只剩一条路（脊柱写闸）。
- registry 运行时行为对外零变：公网 URL、鉴权、工具代理、健康语义、API 形状全保持。
- 迁移可对账、可回滚、可在静窗一次完成。

**Non-Goals:**
- 不重写 mcpgw/auth-server 内部实现（只换读源）。
- 不迁移 registry 的运行时数据（会话、令牌、审计流）——只迁登记记录。
- 不改 tool-surface manifest 契约与 export 脚本输出形状。

## Decisions

### D1. 脊柱存储 = gateway SQLite 扩表，不是共享 registry Mongo，也不是新库

三选一：
- **A（选定）**：gateway SQLite 新增 `mcp_servers` / `skills` 两族表（条目+visibility+tool_list 快照+注释+provenance），复用 packs 已有的 WAL/迁移/备份纪律。
- B：registry Mongo 保留为存储、facet 经 API 读写——那 registry 仍是真源宿主，只是 API 换脸，「双写路径」结构未除，D1 的裁定没兑现。
- C：引入第三个新库——多一个部署面，违背「合并」本意。

选 A 的理由：写闸、审计、对账、备份全部落在谦面一处；SQLite 单文件让「切换前全量 dump」变成 cp 级操作；与 packs 同库使五物种对账天然单事务。

### D2. registry 读脊柱 = pull 式本地只读副本，不是直连脊柱 DB，也不是每请求回源

- **A（选定）**：registry 控制器周期（沿用现有刷新节拍）从脊柱写闸的只读投影端点拉全量，落本地只读副本（现有 Mongo 收缩为该副本或换 SQLite 副本），mcpgw/auth-server 读本地副本不变。拉取失败时沿用上一份副本并如实标 stale（现有健康语义里已有 freshness 概念）。
- B：registry 直连脊柱 DB（跨 pod 共享 SQLite 文件不可行；跨网挂 PG/Mongo 则 ADR-0015 的部署不变被打破）。
- C：每请求回源谦面——网关热路径多一跳网络依赖，谦面抖动即全网关抖动。

选 A：单写者结构性成立（副本只被 pull 覆写），registry 运行时自洽性保持（副本在则服务在），ADR-0015 逐字满足。

### D3. 兼容 facade 放谦面，不放 registry

registry HTTP API 面保留在 registry 进程内（对调用方零改），但其登记读写实现改为「脊柱投影端点」的薄转发——即 registry API 成为脊柱的另一种投影。 facet 桥、reconcile/export 脚本、壹座凭据流不改调用方代码。写语义（POST/PATCH 登记、visibility、注释）转发脊柱写闸并带回审计结果；读语义转发脊柱只读投影。

### D4. 迁移与切换走「停写→迁→双读→切→观察」五步，写进 tasks 而不是临场发挥

对账口径：行数相等 + 逐字段内容相等（`_id`=入口 path 为主键锚）；tool_list 快照与 num_tools 双口径；28 条活册与 §1.1 台账全等。切换点=registry 读源 env 从本地 Mongo 改指脊柱投影（GitOps fd-infra-deploy bump，ArgoCD 滚）；观察期 7 天内旧 Mongo 保留只读（循 11-04 退役先例）。

## Risks / Trade-offs

- [pull 副本的秒级新鲜度落差] → 现有快照语义本就是「注册/刷新时刻」；对账规则已声明快照滞后为常态，stale 标记显式化。
- [迁移漏字段（Mongo 无 schema）] → 迁移器按 §1.1 台账 28 条全字段枚举 + 迁移后逐字段 diff 脚本；未知字段名如实报错不静默丢弃。
- [「Mongo 直补」惯性复发] → 兼容 facade 覆盖全部既有写场景 + registry Mongo 切换后转只读（写操作结构性失败），审计告警直写尝试。
- [静窗停写冲击发布节奏] → 与谦面发布节奏协调选窗；写闸在迁移窗口返回明确的 maintenance 语义码，调用方（publish 环）已有 429/503 退避惯例可复用。
- [SQLite 单文件成为五物种共同故障域] → 与 packs 同域是本设计的意图（单事务对账）；备份纪律（WAL+定期 dump）随 packs 既有节奏走。

## Migration Plan

1. 落脊柱表+写闸+投影端点（谦面侧，先上产但无数据、registry 未切）。
2. 静窗：registry 停写 → 迁移器 Mongo→SQLite（行数+逐字段对账）→ pre-cutover dump 双份（谦面侧+registry 侧）。
3. GitOps bump registry 读源 env → ArgoCD 滚 → 双读窗口（新副本 vs 旧 Mongo 逐字段比对，自动化跑 24h）。
4. 公网回归：28 条活册 tools/list initialize 实弹、匿名 401 门、五语注释投影、壹座装机/凭据流、plaza 机器面对账零漂移。
5. 观察期满：旧 Mongo 转归档（dump 留存），MCP-REGISTRY.md 换锚收尾。

回滚：步骤 3/4 任一失败 → env 回指本地 Mongo（只读副本仍在）+ ArgoCD 回滚，登记写入恢复走 registry（脊柱侧新写入在回滚窗口内人工并回，窗口≤7 天）。

## Open Questions

- 无。副本载体（收缩版 Mongo vs registry 内嵌 SQLite）在 tasks 里作为实现细节由实测性能定，不影响契约。
- **实测结论（2026-11-06 静窗回填）**：副本载体定为 **pull-only 投影副本**——registry 侧不做内嵌 SQLite，改为 ~20-30s 周期拉取 facet 脊柱投影（`GET /api/supply-store/projection`，Bearer 副本 token）进内存/Mongo 只读视图，写链全部经兼容 facade 转发脊柱写闸。实测：27 行副本拉取 20s 周期稳定、公网读面零行为变化、迁移 26/26 AGREE。取舍：Mongo 直写结构性拒绝在 repos 构造期实现（replica 模式下 DocumentDB repos 整体不实例化写路径），避免双写；旧 Mongo 转只读归档。
