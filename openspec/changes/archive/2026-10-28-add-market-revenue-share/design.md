# add-market-revenue-share · Design

## Context

- 现状：市场唯一「交易」是免费订阅 `subscriptions`（`gateway/packs.js:226-233`），无价格/支付/分成；调用量结算走 `gateway/wanxing/core.js` `trySettle`（幂等 key=usage 行 id，挂账停在 `wanxing_caller_state`）；ADR-0022（`docs/adr/0022-*`）写了 deployer 分成账本设计但零实现，且语义是 agent 调用分成。
- 用户 10-27 裁决：造账难度不大但重要，与供给开放同版落地，粗粒度即可。

## Goals / Non-Goals

**Goals:**
- 一次性跑通「付费条目→成交记→内账结算→分成→供应商可看自己的账」最小完整环。
- 所有账本数字可重算、幂等安全、失败如实。

**Non-Goals:**
- 提现通道（v1 闭环抵扣）；ADR-0022 的 agent 调用分成实现（只借账本形态）；多级分销/优惠券/税费；价格谈判或动态定价。

## Decisions

- **D1 账本形态：成交记 append-only，收益账=投影不落计数器。** 沿用 `fleet_runs`「always a projection, never a counter」先例：收益汇总每次从成交记重算（条目量级下成本可忽略），杜绝计数器漂移。拒付/争议以反向行登记。
- **D2 幂等两键：购买幂等键=（buyer, pack, version 或 period 边界），结算幂等键=成交行 id。** 复用 wanxing settle 的 idem+挂账重试模式而非新造。重放安全 > 物理原子：先落成交行（pending）→ 扣减 → 置位，任何一步失败可重试且读面不造假。
- **D3 抽成比例=部署级全局默认档，快照入成交行。** 对齐 ADR-0022 默认 30%；比例改档只影响新成交，历史行不动。不做类目/供应商级议价（粗粒度裁决）。
- **D4 价格声明为版本级商业元数据（非 manifest 文本）。** 理由与署名同理：manifest 不承载作者自写商业声明，且版本 immutable 与价格锁天然同构；改价=发新版，与「市场=唯一分发更新通道」纪律一致。免费=缺省，不影响存量。
- **D5 分成只认成交记，调用侧零交集。** a2a/调用结算链不读不写市场账本；owner 面的花销视图读消费侧（买家成交行），收益侧（vendor）读收益投影，两侧同源于成交行。
- **D6 结算视图 v1=API + facet creator console 补段（复用既有 console 面），不新建门户。**

## Risks / Trade-offs

- [扣减与记账非原子] → pending→settle→挂账重试模式 + 读面如实呈现待结算；对账任务周期性比对 sub2api 余额变动与成交行。
- [价格全免费生态时付费条目冷启动] → 免费条目路径逐字节不变，付费是纯增量；上架价格门只是声明校验。
- [闭环抵扣的合规边界（类储值）] → v1 收益只能抵平台内消费、不可提现，ADR-0022 已述立场；提现立项在先补合规评估。
- [与未来 agent 调用分成（ADR-0022 本体）账本重名/复用混乱] → 表与读面命名锁定 market_*（`market_purchases`/`market_earnings_view`），ADR-0022 实现时另立 deployer_* 。
- [恶意低价换署名/刷榜] → 价格门 + 既有市场卫生基线（Marketplace hygiene baseline）+ 成交记审计可查；策展职能处置。

## Migration Plan

1. 落表：`market_purchases`（append-only，幂等唯一键）、收益投影视图/物化查询函数；无历史数据迁移（纯增量）。
2. 购买路由 + 买家扣减（复用 `lib/sub2api-admin.js`）+ 挂账重试；装前闸：付费条目未成交拒装。
3. 条目价格声明字段（版本级）+ 展示；供应商结算视图 API + facet console 段。
4. 回滚：付费/购买路由下线即恢复全免费语义；成交记只增不删（台账语义）。

## Open Questions

- 订阅期的自动续费/到期回收节奏（v1 到期即失安装资格 or 保留快照）：影响 task 切分表外的商业口径，默认「到期失资格、已装快照不拆」，商业侧再议。
