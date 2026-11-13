# Design: add-owner-cross-line-view

## D1 聚合端点：一端点六分组，每线独立 try/catch

`GET /api/fleets/owner/cross-line-spend`（`server/routes/fleets.js`，owner 组既有鉴权：`resolveUser` 401 门 + owner scope）。响应形状：

```
{ v: 1, sampledAt,
  lines: [ { line: "fleet"|"market"|"wanxing"|"lex"|"wire"|"balance",
             status: "ok"|"degraded"|"unconnected",
             calibre: "<口径文案 key>", reconciledAt: <ms|null>,
             metrics: [...如实可导出读数], error?: "<分类错误>" } ] }
```

- 每线独立 try/catch，单线失败→`status:"degraded"`+`error`，不拖垮响应；lex/wire 无凭据→`status:"unconnected"`（读 `line-credentials.js` 既有连接态判别，零新凭据逻辑）。
- **fleet**：直接复用 `db.spendProjection` 已有聚合（不逐集群展开，主人侧给汇总窗口计数——runs/turns/usage 三窗与 allTime，口径=事实投影）。
- **market**：`gateway/market.js` `purchasesForBuyer(user.email)`（既有读面，buyer email 维度）——聚合面给计数与金额字段，口径=消费侧成交记。
- **wanxing**：服务端 fetch `${WANXING_FACADE_URL}/api/wanxing/v1/ops/usage`（Bearer=registry service credential，既有 `AGENT_SERVING_REGISTRY_TOKEN`）取 byCaller/byAgent，按主人 email 过滤其 caller 行；**平台凭据代读例外**在此一处（账本真源在 facade pod，壹座无直读通道），口径标注如 spec 场景。facade 不可达→degraded。
- **lex**：读法与 `LexBoardAdapter` 同源（`/api/console/usage` 等 + lex 凭据）；为避免两处漂移，把 adapter 的凭据取值+fetch+401 翻面提炼为 `lib/board-adapters.js` 导出的共享 helper（`fetchLexUsageFor(email)` 类），adapter 与聚合面同消费——**不复制读法**。
- **wire**：同上，`WireBoardAdapter` 客户面读法提炼共享 helper（datasets/quota 读数）。
- **balance**：`gateway/packs.js` billing_snapshots 按 email 最新快照（既有表既有索引，只读）。

## D2 不并账铁律的落点

聚合面**不计算**任何跨线总额字段；前端也不渲染总额行。六分组各带 `calibre`（口径 key，前端查 i18n 文案）与各自货币/单位字段（usage=次数/token、金额=各自币种口径），类型异构天然阻止混加——并在 schema 层不给总额一个可填的槽。

## D3 前端：第四路读面

`TeamsOverviewBoard.tsx` 增第四路 `fetchCrossLineSpend()`（`fleet-owner-api.ts` 新类型），渲染「跨线花费」区：六格（线名/读数/口径角标/对账时间/深链到 `/boards/<line>`）。降级三态照 spec：degraded=错误说明+重试按钮（单线重试=仅重新 fetch 该端点）；unconnected=未连接+去连接入口（既有线连接入口路由）。加载与既有三路互不阻塞。

## D4 平台 env 增量

platform deployment 需补 `WANXING_FACADE_URL=http://10.43.33.112:3080`（facet 同值；hostNetwork ClusterIP 字面量惯例照 wanxing-contract-hardening 4.2 例外注记）。registry token 已在 env（`AGENT_SERVING_REGISTRY_TOKEN`）。GitOps 增量随本单上产走。

## D5 备选与裁决（承 charter design D5）

- 「新建 unified-billing capability」→ 否（charter D5 红线：诱导并账）。
- 「六账各开端点由前端逐线拉」→ 否：六个端点=前端六次串行竞速+每线自拼降级，不如服务端一次聚合+单端点独立分组降级简单可测；且 lex/wire 401 翻面逻辑（清凭据缓存）必须服务端做。
- 「萬星账本同步进壹座库再读」→ 否：违反各账独立真源红线，且引入双写漂移面；代读+口径标注是如实形状。
- 「lex/wire 读法在聚合面内重写」→ 否：两处读法漂移前科（B2 对账 51 漂移教训），提炼共享 helper 单一真源。

## Q-A 身份与 401 翻面（章程 4.4 联动）

聚合面经 lex/wire 用户凭据读数时沿用 adapter 既有 401 语义（清凭据缓存→该线 unconnected）。章程 4.4 的 SSO 直通/401 翻面**实证**随本单走查任务补证（连接→注入→401→翻面→恢复各一条端到端记录），不改 mint/renewal 代码——`line-token-renewal.js` 15min 轮转在位零改动。

## Q-B 与 B1 instances 族的关系

本单只读账面，不消费 B1 的 instances 登记（那是运行态出处账，非消费账）。若未来主人视图要呈现实例状态，另立单消费 instances 投影——不在本单范围。
