# Proposal: add-owner-cross-line-view

## Why

線-壹座深度結合章程 C1（`line-integration-charter` 4.1-4.2）：六本账（回合计量 / 市场成交 / 萬星结算 / 识律用量 / 柏讯消费 / sub2api 余额快照）各自独立成账且已上产，但主人侧没有任何一处能看到「我的钱花在哪条线上」。既有 `fleet-owner-surface` 花销视图只覆盖 (a) 回合/token 投影、(b) 集群部署 key 的 sub2api 周期对账、(c) 市场成交行——全是单集群或单域口径；`agent-teams-overview` 综合看板聚合的是团队状态而非跨线花费。章程 L6 层的缺口「跨线账未合流到主人视图」是本单要收的口。

**红线（D5，2026-10-29 paas 评审拍板）**：不把六本账并成一本账。各线独立结算/独立滚版不推翻，本单只做主人侧聚合**读**面；不新建 capability（`unified-billing` 一类新 spec 被明确否决——会诱导并账），只修改既有 capability。

## What Changes

壹座服务端新增**只读跨线成本聚合面**（一个聚合端点 + 综合看板一个成本区），把五条线的消费读数按线分组呈现：

1. **服务端聚合读面**：`GET /api/fleets/owner/cross-line-spend`（挂在既有 `fleets.js` owner 组，同一 owner scope 与鉴权）。按线分组返回六账各自的「如实可导出读数 + 口径标注 + 最近对账时间」，每线独立 try/catch：
   - **fleet（回合计量）**：既有 `spendProjection` 聚合（runs/turns/usage 投影，`fleet_runs` 真源，复用现有实现零新查询）
   - **market（市场成交）**：`gateway/market.js` `purchasesForBuyer(email)` 消费侧读数（buyer email 维度，status/settled 口径）
   - **wanxing（萬星结算）**：facade `GET /api/wanxing/v1/ops/usage` 经 `WANXING_FACADE_URL` + registry service credential 读 byCaller/byAgent 结算账（admin/runner 凭据门既有；壹座服务端代读=主人本人已是 admin 或以服务凭据读 ops 面——**仅此一账例外走平台凭据**，因 facade 账本真源在 facade pod、壹座无直读库通道；口径标注「服务凭据代读 ops 面」）
   - **lex（识律用量）**：既有 `LexBoardAdapter` 同源读法（`/api/console/usage` + console 凭据）按用户凭据态降级——未连接=「未连接」不填 0
   - **wire（柏讯消费）**：`WireBoardAdapter` 同源读法（`/api/v1/datasets/quota` 等客户面读数）按 wire-customer 凭据态降级
   - **balance（sub2api 余额）**：`gateway/packs.js` `billing_snapshots` 周期快照（deployer 账户粒度，粗粒度归属口径——沿用既有口径文案）
2. **前端成本区**：`TeamsOverviewBoard.tsx` 增「跨线花费」区（既有三路读面之外新增一路，遵守 `agent-teams-overview` 独立降级条文）：每线一格（线名/读数/口径/最近对账时间/去对应线看板深链），任一线失败只降级该格（error 标注+重试），其余线照常。
3. **硬纪律**（复用 `line-boards/spec.md` 既有条文）：无真实数据源的指标不呈现；缺数据如实降级；无凭据渲染「未连接」与去连接入口（lex/wire）；MUST NOT 硬编码占位值（如恒零）；不做并账总额（六账口径各异，MUST NOT 混加成一个总数）。
4. **不夹带**：`/` 发现面（章程 Q1）不动，`App.tsx:323` 不碰；SSO 直通/401 翻面实证是章程 4.4 的**验证任务**（随本单走查补证，不改代码）。

## Capabilities

### New Capabilities

（无——章程 4.2 红线：不新建 capability。）

### Modified Capabilities

- `fleet-owner-surface`: 花销视图增「跨线分组」要求——六账各自独立真源的只读聚合读面、按线分组、各带口径与最近对账时间、互相不混加；任一线失败只降级该线分组；无凭据线渲染未连接态；无端点指标不呈现。
- `agent-teams-overview`: 综合看板增第四路读面（跨线花费区）——与既有三路并列为各自独立降级的数据源，失败标注不可用+重试入口，不进整屏错误态。

## Impact

- **代码**：`server/routes/fleets.js`（新聚合端点，复用 `requireOwnedFleet`/`resolveUser` 鉴权组）、`gateway/market.js`（`purchasesForBuyer` 已有，零改动直接调用）、`gateway/packs.js`（`billing_snapshots` 读法已有模式）、`lib/board-adapters.js`（lex/wire 读法提取为可复用函数或聚合面内重实现同源读法——design 决）、`web/src/components/fleet/TeamsOverviewBoard.tsx` + `web/src/lib/fleet-owner-api.ts`（前端一路+类型）、i18n 五语词条。
- **依赖**：`WANXING_FACADE_URL`（facet 已配，platform 侧需补 env）+ registry service credential（`AGENT_SERVING_REGISTRY_TOKEN` 已在 platform env）；lex/wire 靠用户既有线凭据（零新凭据）。
- **风险**：萬星账走平台服务凭据代读是唯一口径例外（facade 账本真源不在壹座库内）——proposal 显式声明并要求口径标注，不冒充直读；lex/wire 未连接用户会看到「未连接」而非数据（如实降级的正确形状）。
- **不做**：并账总额、新 capability、`/` 首屏改动（Q1 待裁）、跨线写入或结算联动（只读铁律）。
