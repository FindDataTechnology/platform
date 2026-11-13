## Why

市场今天没有「交易」这件事：订阅免费、无价格概念、无任何订单/分成代码（ADR-0022 的 deployer 分成设计从未实现，且它管的是 agent 调用分成，不是「上架物被买走」）。2026-10-27 产品线裁决（`docs/fleet-platform-supply-open-requirements.md` D，用户 10-27 补充：造账难度不大但很重要，必须与供给开放同版落地、粗粒度即可）：计费完整模型 = 调用量计费（既有，不动）+ 市场抽成（本单）。本单依赖姊妹单 `add-vendor-supply-open` 的 vendor 归属骨架。

## What Changes

- **付费条目与价格形态**：市场条目可声明价格与计费形态（一次性买断 / 订阅期），价格随版本 immutable 锁定，免费条目维持现状默认。
- **成交记（append-only）**：购买动作产生不可变成交行——买家、条目、版本、价格、抽成比例快照、供应商收益额、幂等键；失败如实分类（余额不足/条目不可售/重复成交幂等）。
- **内账结算通道**：成交经买家 sub2api 余额扣减（幂等键防重放），平台抽成与供应商收益随成交行同笔登记；闭环抵扣不提现（ADR-0022 形态借用），v1 不接外部支付。
- **供应商收益账与结算视图**：vendor 名下成交聚合与收益余额可读（台账投影，非计数器），消费侧记账与供方记收益两清。

## Capabilities

### New Capabilities

- `market-revenue-share`: 市场成交记、内账结算、平台抽成与供应商收益账/结算视图。

### Modified Capabilities

- `pack-marketplace`: 付费条目的价格展示、购买动作入口、未成交安装付费条目如实拒绝。
- `platform-billing`: 市场成交经边界内账结算（买家 sub2api 扣减幂等、平台抽成归集、vendor 收益挂账）。

## Impact

- **存储**：gateway 库新增成交记与收益投影表；账本只增不改。
- **代码**：`gateway/packs.js`（条目价格字段/购买路由/安装付费闸）、`lib/sub2api-admin.js` 扣减复用、facet 面供应商结算视图（API 先行）。
- **明确不动**：调用量计费链（`platform-billing` 既有 Requirement 逐字节不变）；ADR-0022 的 agent 调用分成（`deployer_earnings`）仍是独立待办，本单只借其账本形态，不合并实现。
- **依赖顺序**：归档在 `add-vendor-supply-open` 之后（收益归属字段为其产出）；owner 面花销视图的市场行（`add-fleet-owner-surface` C'）依赖本单成交记。
