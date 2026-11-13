## Why

供给域闭环的三个接口按 `docs/supply-domain-roadmap.md` §5 契约表仍是「新」（零代码）：**实例回报**（萬星→脊柱，facade 实例状态/出处无登记处可读）、**晋升 fork 语义**（promote 单向闸已落但 fork 范围裁决未成文，Q2 悬置）、**通知触达**（微信订阅模板悬置）。章程 design D4 定过收口形状：**单向 + 出处 + 诚实降级**三件套，备选「双向同步」被否（与 D7「素材静止归谦面、智能体工作归壹座/萬星」冲突，W2 已把单向闸回归钉死）。B1 是章程 §3 索引的实施单：把三个接口从契约表落到代码与 spec，让「脊柱登记处能读到萬星实例状态且带 provenance、且脊柱无任何回写运行态路径」可验证。

## What Changes

- **实例回报（萬星→脊柱，单向登记）**：壹座新增 `lib/supply-instance-report.js`——以既有 `wanxing-fleet` 部署读面（`localFleetSnapshot`）为源，经脊柱写闸 `POST /api/supply-store/instances/upsert`（新路由，facade 侧 registerSupplyStoreRoutes 补 instances 族）把实例状态登记进脊柱（字段：instance_id / deployment 状态 / runner / pack 来源 / provenance（reported_at/source=paas-cell/seat）/ TTL）。**单向铁律**：脊柱侧只存登记不驱动运行态——无任何「脊柱→萬星」的下发路径；登记失败降级为日志+计数（不阻塞部署面）。
- **晋升 fork 语义收口（Q2 裁决记录）**：fork 语义**已成文**——W2 活单 `agent-promotion-channel` delta「v1 fork 范围如实划定」条文（preset/配置/skills、excluded=记忆/会话历史、扩围走后续单独探索）即裁决内容；**本单裁决=维持现范围**（记忆/会话历史属用户私有运行态，fork 入草稿跨隐私边界且与单向闸同构冲突；开放须另立单走隐私评审）。落地=裁决记录（本单 design D3 + 章程 3.2 勾选），零代码零 spec 变更。
- **通知触达挂账成文**：in-app 侧沿用 `scheduled-task-notifications` 既有语义（零改动）；微信小程序订阅模板**依赖用户行动**（模板申请）如实挂账（本单 design Open Questions Q-C + 章程 3.3）——MUST NOT 伪装已通。

## Capabilities

### New Capabilities

- `supply-instance-report`：实例回报单向登记契约——萬星实例状态 SHALL 经写闸入脊柱登记处并带 provenance；脊柱 MUST NOT 有回写运行态路径；登记通道失败 SHALL 降级不阻塞部署面；读面（脊柱投影 instances 段）SHALL 可反查 provenance。

### Modified Capabilities

（无——Q2 fork 语义已在 W2 活单 `agent-promotion-channel` delta 成文（「v1 fork 范围如实划定」），本单只落裁决记录；通知触达为挂账记录非 spec 行为。）

## Impact

- **paas**：`gateway/supply-store.js`（instances 表+路由族+投影段）、`lib/supply-instance-report.js`（新）、`server/routes/wanxing-fleet.js` 部署写路径后置 hook（零行为变更，仅追加登记调用）。
- **paas/facet（供给域 facade 侧，架构勘验纠正：写闸真源=paas `gateway/supply-store.js` registerSupplyStoreRoutes，非 fd-wanxing）**：`spine_instances` 表 + `instances/{upsert,patch,delete}` 路由族（照 mcp-servers 族同构，actor/source 审计同闸）；`SPINE_INSTANCES_ENABLED` 缺省关，开=true 才启用。fd-wanxing 本单零触碰（实例状态读源在壹座本地 fleet 库）。
- **脊柱 schema**：`spine_instances` 表（instance_id 主键 / status / runner_id / source_pack_id / provenance JSON / TTL）——与 mcp_servers/skills 同库同闸。
- **不触碰**（fd-wanxing 全仓零触碰——实例状态读源在壹座本地 fleet 库，`localFleetSnapshot()` 既有）：promote 端点行为（只成文不改码）、六本账边界、创作面位置、W3 域名归一、五线 slug。
- **验证**：脊柱登记处读得到萬星实例状态带 provenance；全链 grep 证「无回写运行态路径」；promote 回归钉绿；登记通道断开时部署面无感。
