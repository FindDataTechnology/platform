# Design: add-supply-catalog-unification

## Context

三目录现状：谦面目录 API 族已存在且是 plaza 的既定数据源（`marketplace.json`、`/api/mcp-catalog`、`/api/skills-catalog`，plaza-export 带计数对账与退避重试）；壹座 extension-marketplace 另有一套「bundled JSON + 可选 registry 直连 + 冲突 bundled 赢」的装载（`GET /api/extensions/market`，TTL 刷新 + `market_changed` WS 广播）；plaza 的 facade/official-data 两类由 pack badge 启发式派生（`plaza-export.mjs` 的 category 推导）。facet 侧已有内部 deployments API（serving plane 只读，内部凭据）。

## Goals / Non-Goals

**Goals:**
- 目录读路径在**服务契约层**合一：五物种一个目录 API 族，注释层形状全物种。
- 壹座侧改造最小面：只动 `GET /api/extensions/market` 的装载来源与 bundled 文件的生成方式，安装路径、`requiresConfig` 推导、组门控、WS 广播全部不动。
- facade / data-anchor 获得真源喂给，plaza 导出与对账 gate 扩五物种。

**Non-Goals:**
- 不做 registry 与 pack store 的存储合并（目录层单源即可兑现「三目录变一目录」）。
- 不动 pack 市场发布链、计费、橱窗 UI 结构。
- 不做 facade 实例的深度运维面（状态回报 best-effort，unknown 如实标注即可）。

## Decisions

### D1 目录 API 形状：端点族扩展，不做 mega endpoint

沿用现有端点族，新增两物种端点：`/api/facades-catalog`（deployments 公开投影：仅公开分享态 facade，字段=名称/简介/部署出处/状态/注释投影）、`/api/data-anchors-catalog`（DAAS 目录投影）。每端点带 `locale` 参数走注释层解析链（locale > Accept-Language > zh；无注释 zh 兜底），物种枚举版本号随 `catalog.json` 的 species 元数据暴露。
**为什么不做单一 `/api/supply-catalog` 聚合端点**：plaza 与 CLI 已按端点族消费，聚合端点会制造第二形状；五物种各自分页/可见性语义差异大，硬塞一个信封会重演「目录重释准入」。物种枚举+注释形状的一致性由 supply-catalog spec 约束，不由单一 URL 承担。

### D2 facade 公开投影建在 facet，读内部 deployments 面

facet 在自身进程内把 deployments rows（已有内部面）投影为公开 facade 目录：准入=公开分享态（对齐萬星分享页语义）；状态字段接受 serving plane 回报，缺失即 `status: "unknown"` 如实输出。**不在 plaza-export 里直连萬星**——plaza 只消费目录端点，保持「导出不重释准入」纪律。
备选（否决）：萬星直接向 registry 登记实例——会让实例真源分裂到第二个登记处，与 W1 目标相反。

### D3 data-anchor 喂给：DAAS 侧导出、谦面侧拉取

v1 范围=DAAS 目录类（实体+指标，对齐 `daas-supply-domain` 元数据同步器的目录表口径；观测值排除）。实现为 DAAS/business-mcp 侧一个只读目录导出端点（或定时导出文件），facet 定时拉取入目录投影，provenance.source=`daas-catalog`。跨仓改动（finddata 根）只此一处、只读。

### D4 壹座切换顺序：先快照生成，再读路径切换，bundled 不删只换血

1. 新增 `scripts/export-market-snapshot.mjs`：从目录 API 族导出生成 `market-catalog*.json`（带 `_meta.as_of`），替换仓库内手编文件——零行为变化（无配置部署继续读它）。
2. 装载器加 `FACET_CATALOG_URL`（可选 `FACET_CATALOG_TOKEN`）在线源：匿名/凭据读目录端点族，映射为现有 market entry 形状（MCP → `configTemplate` 网关模板，沿既有推导）；TTL 刷新与 `market_changed` 沿用；**删除 bundled-赢合并规则**（单源，无合并）。
3. `MARKET_REGISTRY_*` 保留兼容窗（刷新时 log deprecation）；与 `FACET_CATALOG_URL` 并存时后者赢并告警点名被忽略变量。
**回滚**：配置层回退——unset `FACET_CATALOG_URL` 即回离线快照；快照生成是幂等导出，可随时重跑。

### D5 对账 gate 扩物种，badge 派生删除

plaza-export G1 从三源扩五源（facades 对 deployments 投影计数、data-anchors 对 DAAS 投影计数）；`category` 推导中的 badge/名称启发式分支删除，`facade`/`official-data` 改为直接取自对应端点。快照陈旧性与目录陈旧性统一以 as-of 戳暴露。

## Risks / Trade-offs

- [壹座→谦面新增一跳，谦面不可达时市场空] → 沿用既有模式：拉取失败保 last-good + 告警；无配置部署根本不发起在线读取（快照兜底）。
- [离线快照陈旧误导运维] → `_meta.as_of` 戳 + 管理端可见；发布节奏与目录刷新同窗（快照随版本发布重生成）。
- [DAAS 端点跨仓协调拖期] → data-anchor 物种端到端可独立后置：目录物种枚举带版本，DAAS 喂给缺席时该物种计数为 0 且 provenance 标明源缺席，不阻塞其余四物种与壹座切换。
- [registry 直连既有部署（自部署配了 MARKET_REGISTRY_*）在兼容窗后断] → 兼容窗内告警日志先行两个发布周期；W3 前不撤变量解析，只撤文档推荐位。

## Migration Plan

1. facet：两新目录端点 + deployments 公开投影（先后可独立上）。
2. DAAS 导出端点（跨仓，可与 1 并行）。
3. 壹座：快照生成脚本落地换血 → 装载器加在线源 → 兼容告警。
4. plaza-export：五源接入 + G1 扩展 + badge 派生删除（依赖 1/2）。
5. 验收：三柜×橱窗×门厅逐条对账零漂移；无配置部署回归；WS `market_changed` 回归。
6. 回滚：任何一环失败按 D4 回退配置或 revert 对应镜像 tag，端点族新增不改旧形状，旧消费方零感知。

## Open Questions

- 萬星实例状态回报的承载（push webhook vs facet 拉取）——不影响契约（状态字段语义已定：present 或 unknown），实施时按萬星侧现成机制取最短路径。
- data-anchor 目录条目的粒度（实体级 vs 指标级 vs 混合）——v1 按 DAAS 目录表天然粒度导出，导出后由计数对账锁定，粒度选择不改变契约。
