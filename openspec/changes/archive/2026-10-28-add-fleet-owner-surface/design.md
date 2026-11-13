# add-fleet-owner-surface · Design

## Context

- 复用资产（摸排锚点）：`GET /api/fleets/overview`（`server/routes/fleets.js:914`，组织级聚合+决策 top3）、cockpit `:1002`、KPI 槽位与 `buildLatestView`（`server/fleet-reports.js:299`）、决策车道 `decision_items`（`fleets.js:1264/1323`）、模板实化 `from-template`（`:1085`）+ 点燃 `start`（`:1138`）、gw 跨机投影 `gateway/fleet-cells.js`。
- 现状缺口：web 端无任何组件调用 `from-template`；模板无参数槽契约；跨机休眠=honest absence 隐身；无 per-fleet 花销读数（`wanxing_usage` 无 fleet 维、`fleet_runs` 有 token 无金额）。
- 用户裁决（2026-10-27）：花销造账纳入本版、粗粒度即可；经营面与供给/分成两单同版落地。

## Goals / Non-Goals

**Goals:**
- 主人视角四块面（总览坞/读数/花销/装作）全部复用既有机制接出，不造新运行时与新状态机。
- 花销金额粗粒度但数字有源（key 消耗对账），口径如实标注。

**Non-Goals:**
- 迭代回路与 digest 订阅推送（`add-fleet-owner-iteration`）。
- per-回合精算金额、成本分摊到岗位的细账（粗粒度归属即终态 v1）。
- cockpit 组件的实时亮化（`add-fleet-ops-canvas` 在跑，归档排序注意）。

## Decisions

- **D1 总览坞=owner 聚合读面接入 FleetsPage 组件族，不另立页族。** 新增 owner 聚合端点（组织内集群行+告警计数+跨机占位）挂在既有 fleets 路由；前端在 FleetsPage 族内加坞面视图与告警直达，驾驶舱详情页复用不变。备选（全新「经营中心」应用）被否：组件族重复、路线碎片化，违背「与 ClusterComposerModal 同一组件族」的需求书指示。
- **D2 跨机占位=注册名录×采样差集的读时投影。** gateway 侧新增（或扩展 `fleet-cells`）owner 聚合时取「已注册 cell 名录 − 本轮已应答」差集产「休眠中」占位行；随 `add-cell-lifecycle` steward 常驻化落地，名录更准时无需改本单逻辑（数据源升级）。备选（存快照表）被否：占位是派生视图，落库必漂移——沿用「派生视图为读时计算」的 fleet-core 纪律。
- **D3 花销金额=部署 key 消耗对账（ADR-0011 立场延伸）。** 集群成员 → 部署 agent → deployer key；周期任务经 sub2api admin API 快照各 key 余额，前后差按集群归属聚合为粗粒度金额；token 投影取 `fleet_runs.usage_*`；市场行读 `market_purchases` 消费侧。三类读数同屏不混加，各标口径。备选（逐回合 × 模型价目精算）被否：平台无价目表（价格在 sub2api），自造价目即新账轨，违背「不新增计账轨道」。
- **D4 参数槽=模板清单可选扩展段，向导纯客户端生成。** `manifest.fleet.params` 经模板校验器（`fleet-template.js`）成型；向导按槽 schema 生成表单，提交即 `from-template` 入参；实例化器（`fleet-provisioner.js`）按槽映射消费。备选（服务端向导状态机）被否：无服务端状态需求，向导是表单映射。
- **D5 装作入口=市场模板卡直达，判定「模板 iff manifest.fleet 段存在」——沿用既有分组语义，不在市场加新类目。** 模板卡上出现「装作」动作（详情既有 action bar 模式），装完落总览坞。

## Risks / Trade-offs

- [key 消耗对账把非本集群消耗误归属（同一 key 被多处用）] → 口径明示粗粒度、按部署绑定关系归属；部署者级聚合计入其各集群之和可核对总量，不追 per-回合精度。
- [对账依赖 sub2api admin API 可用性] → 周期任务失败如实呈现「最近对账时间」老化，不虚构金额（honest absence 原则同 fleet 投影）。
- [参数槽自由映射被滥用指向任意成员字段] → 槽映射走白名单键集（节奏/模型/预算等声明位置），实例化器拒白名单外键。
- [owner 聚合端点数据面变宽的性能] → 聚合为读时投影+短缓存（沿用 cell-sampler 采样纪律），集群数按组织配额有界。
- [与 `add-fleet-ops-canvas` 同触 FleetsPage/cockpit 邻域产生归档冲突] → 归档排序：ops-canvas 先归（其在跑），本单归档时 rebase delta。

## Migration Plan

1. 模板参数槽：schema+校验器+种子模板补槽（官方种子库守恒纪律：加槽不改语义）。
2. 实例化器消费入参 + 向导组件 + 市场卡入口；装作路径 e2e（真机点燃首跑）。
3. owner 聚合端点 + 坞面视图 + 告警直达；跨机占位差集（先 mock 名录，随后由 cell-lifecycle 名录接管）。
4. 花销投影 + 对账周期任务 + 市场行读面。
5. 回滚：坞面/向导为纯增量面，下线即恢复；对账任务停用即可。

## Open Questions

- 金额对账周期（默认日级）与快照保留窗（默认 90 天）——运营可调，不阻塞 task 切分。
- 组织维度归属（owner=person vs org）若客户侧组织模型后续落地，坞面 scope 键从 user 升到 org 为平移改动（读面参数化已预留）。
