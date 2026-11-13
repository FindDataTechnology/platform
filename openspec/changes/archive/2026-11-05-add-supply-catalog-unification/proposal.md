# Proposal: add-supply-catalog-unification

## Why

供给域路线第一波（`docs/supply-domain-roadmap.md` W1）：同一批素材的「目录」目前被实现了三遍——壹座 extension-marketplace 自带 bundled 策展副本（`market-catalog*.json`，名字冲突时 bundled 赢，是独立于 registry 的第二策展真源）、谦面聚合一遍 registry、plaza 再从谦面导出；且门厅的 facade（AI 分身）与官方数据锚两物种是从 pack badge 启发式推导的，不是真源投影。三目录三处同步、两物种无真源，是三面功能重合的根。

## What Changes

- **统一供给目录读路径**：谦面目录 API 族成为五物种（pack / skill / mcp / facade / data-anchor）的唯一目录契约，注释层形状全物种覆盖，准入由各物种真源自身决定（目录不重释准入）。
- **壹座侧废第二策展真源**：extension-marketplace 停用手编 bundled catalog 与「bundled 赢」合并规则；在线读谦面目录投影，bundled 文件降级为**导出管线生成的离线快照**（带 as-of/provenance），仅无配置部署兜底。**BREAKING**（对自部署运维：`MARKET_REGISTRY_*` 直连进入弃用兼容期，推荐改配 `FACET_CATALOG_URL`）。
- **facade 物种真源化**：门厅/目录中的 facade 条目改由部署实例真源喂给（facet deployments 面 + 萬星回报的实例状态，缺失如实标 unknown），pack-badge 推导路径退役。
- **data-anchor 物种真源化**：官方数据锚改由 DAAS 目录面喂给（v1 范围=目录类：实体+指标；观测值不入），启发式名称匹配退役。
- **plaza 导出对齐**：五物种各经自身真源公面 admit，对账 gate（G1）扩到五物种；badge 派生逻辑删除。
- **伞文档注记**：`docs/facet-wanxing-roadmap.md`、`docs/facet-market-roadmap.md` 头部加指向 `docs/supply-domain-roadmap.md` 的「定位以本文为准」注记。

Non-goals：不迁移创作面 `/studio`（W2）；不做域名/品牌归一（W3）；不动 pack 发布链与计费（已单源）；不做 registry 与 pack store 的物理存储合并（目录层单源先行，存储合并另行立项）。

## Capabilities

### New Capabilities
- `supply-catalog`: 统一供给目录契约——五物种唯一读路径、注释层全物种、facade/data-anchor 两物种的真源喂给与准入、离线快照作为生成物的纪律。

### Modified Capabilities
- `extension-marketplace`: 目录来源需求改写——从「bundled JSON + 可选 registry 直连、冲突 bundled 赢」改为「谦面目录投影 + 生成的离线快照兜底」，单源无冲突合并；`market_changed` 推送与零配置三件套不变量保留。
- `agent-materials-plaza`: 物种准入与对账需求扩为五物种——facade 经 deployments 面、data-anchor 经 DAAS 目录面 admit，badge 推导退役；计数对账 gate 扩物种。

## Impact

- **谦面（facet/）**：目录端点族补 facade、data-anchor 两物种（含注释投影与可见性）；deployments 数据已有内部面，需新增公开投影（仅公开分享态）。
- **壹座（server + web/src/components/extensions/）**：`GET /api/extensions/market` 读路径切换；新增快照生成脚本；`MARKET_REGISTRY_*` 兼容期告警。
- **plaza（scripts/plaza-export.mjs）**：两新物种源接入、G1 对账扩展、badge 派生删除。
- **外部依赖**：DAAS 目录面（`daas` PG / business-mcp 目录端，跨仓 finddata 根）——只读消费；萬星实例状态回报为 best-effort，缺失不阻塞导出。
- **风险**：壹座→谦面目录调用新增一跳（沿用 plaza 已验证的匿名公面读取+退避重试模式）；离线快照陈旧性以 as-of 戳可见。
