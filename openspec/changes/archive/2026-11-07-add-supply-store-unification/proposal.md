# Proposal: add-supply-store-unification

## Why

W1（`add-supply-catalog-unification`，2026-11-05 归档）统一了目录**读路径**——谦面目录 API 族成为五物种唯一目录契约——但**物理存储**仍是两本账：pack 在谦面 gateway 的 SQLite，skill/MCP 登记记录（条目、可见性/组、tool_list 快照、supply 注释）在 registry 自带 Mongo（`mcp_registry.mcp_servers_default` 等）。双存储=双写路径：10-14「注册进已退役栈=黑洞」事故类在第二个登记存储存在期间是结构性的；`reconcile_mcp_registry.py`、手工 Mongo 直补等对账/修缮脚本是这笔债的常态税。`docs/supply-domain-roadmap.md` D1 已裁定 registry 与谦面 store 合并为脊柱内部组件，W1 proposal 明确挂账「存储合并另行立项」——本 change 即该挂账的清偿。

## What Changes

- **脊柱单一登记存储**：谦面 gateway 侧 SQLite（现 packs 存储）扩 skill / MCP 两物种登记表（条目、visibility/groups、tool_list 快照、supply 注释、provenance），成为唯一物理登记真源；registry Mongo 退役为迁移前的历史归档。
- **registry 转执行面 adapter**：mcpgw 网关（nginx 路由/健康探活/工具代理）、auth-server（M2M/token）、凭据服务继续在 `mcp.finddatatech.cloud` 不变服务（ADR-0015：软件/域名/部署不动）；其读源切换为脊柱存储投影（read-through），registry 不再拥有登记写路径。
- **写路径一条路**：登记/可见性写入统一走谦面侧脊柱写闸（同一身份闸、同一审计）；registry HTTP API 面保留为脊柱存储之上的兼容 facade（facet 桥、reconcile/export 脚本、壹座 credential_ref 流照常工作）。
- **BREAKING**：直接写 registry Mongo 的路径（mongosh 直补、直写 `mcp_servers_default` 的脚本——「Mongo 直补」配方类）在切换后不再受支持；一切写入走脊柱写闸。
- **visibility 元数据原生入脊柱**：groups/visibility 成为脊柱原生字段（替代 registry-groups.json 手工映射与桥上 fail-open 补丁类）；与 finddata 根在途 change `carry-registry-visibility-through-bridge` 协调——该单的 B 方案（元数据治本）由本单原生实现后，其桥上过滤改为脊柱投影。
- **数据迁移与切换纪律**：Mongo → 脊柱 SQLite 迁移（行数+内容对账）、双读窗口、切换点单写者强制、切换前全量 dump（循 11-04 1.1G 审计 dump 先例）、env 回指回滚预案。
- **对账口径换锚**：MCP-REGISTRY.md 台账对账对象从 registry Mongo 换到脊柱存储；`reconcile_mcp_registry.py` / `export_surface_commercial.py` 改锚或改走兼容 facade。

**Non-goals**：网关代理/鉴权/健康行为不变（ADR-0015）；tool-surface manifest 契约不变；facade / data-anchor 两物种维持各自真源喂给（W1 裁定）；壹座读路径零改（已走 `FACET_CATALOG_URL`）；pack 物种存储不动（谦面已是 pack 真源）；不做 k8s 拓扑变更（registry 栈三 pod 原地）。

## Capabilities

### New Capabilities
- `supply-store`: 供给脊柱物理存储契约——skill/MCP 两物种登记记录的唯一物理存储、单一写闸（身份+审计）、registry 执行面的 read-through 投影与新鲜度纪律、迁移/切换/回滚纪律、registry HTTP API 兼容 facade 的义务边界。

### Modified Capabilities
- `facet-platform`: MCP 卡片与 skills 目录的数据源从「registry 只读聚合」改为「脊柱存储直读」；「facet 面不修改 registry 条目」改为「facet 面即登记真源宿主，写仅经脊柱写闸」；ADR-0015 边界（registry 软件/域名/部署不变）保留为显式承诺。

## Impact

- **gateway/（谦面，paas 仓）**：SQLite 扩 skill/MCP 登记表 + 脊柱写闸 API + registry 兼容 facade 端点族（`/api/servers*` 语义对齐）。
- **registry k8s 栈（跨仓 finddata 根：fd-infra-deploy + mcp-registry ns）**：registry/auth-server/mcpgw 读源切脊柱（env/配置），Mongo 退役归档；GitOps 走 fd-infra-deploy 常规 bump。
- **paas 脚本**：`reconcile_mcp_registry.py`（finddata 根）/ `export_surface_commercial.py` 改锚脊柱或改走兼容 facade；`scripts/test-supply-catalog-yizuo.mjs` 扩存储断言。
- **壹座**：`registry-bridge.js` 读路径零改；credential_ref / per-line 凭据分派流走兼容 facade 不变。
- **协调**：finddata 根在途 change `carry-registry-visibility-through-bridge`（0/0）——本单落地后桥上元数据透传改为脊柱原生投影，该单应收窄为「桥读脊柱投影的回归钉」或并入本单验收。
- **文档**：MCP-REGISTRY.md §0 对账规则换锚（对账对象、修复命令）、registry-groups.json 手工映射退役记录；registry-maintenance.md 增补发布记录。
- **风险**：registry 是全网关上游（28 条活册、五语供给注释全链上游），切换窗口必须停写并在静窗执行；迁移对账以行数+逐字段内容双口径；回滚=pre-cutover dump + registry env 回指本地 Mongo（保留只读副本至观察期满）。
