# Design: add-turn-pricing

> 底稿切片③。词元面实证（~/finddata/sub2api backend 源码）：
> `GET /api/v1/admin/channels/model-pricing?model=X` → `{found, input_price, output_price,
> cache_write_price, cache_read_price, reasoning_effort_multipliers, ...}`（**per-token** 单价）；
> `GET /api/v1/admin/groups` 组列表含 `rate_multiplier`；`POST /api/v1/admin/dashboard/users-usage`
> → `stats[id].today_actual_cost`（计费真数，day-scoped）。

## Context

- 切片②已把 (model, provider, day) 记到日行——本片补「这组合值多少钱」。
- `lib/sub2api-admin.js` 是唯一门（ADR-0011），已有 findUserByEmail/readUser/probeKey/
  listKeyModels/adjustBalance；`SUB2API_ADMIN_KEY` 在 platform-secrets、`SUB2API_BASE_URL`
  与 LLM_BASE_URL 同走 127.0.0.1:32080 反向隧道。
- 计费真数对账源：`today_actual_cost`（词元 usage log 聚合，含全部折扣/倍率后的实收）。

## Goals / Non-Goals

- Goal：单价缓存 + 回合时刻价估算进日行 + 对账因子可见。
- Non-Goal：组倍率/订阅折扣进估算（v1.1 随对账因子校准）；计费面写操作；多租户价目分账
  （統計面 S4 的事）；reasoning_effort 倍率（表已在响应内，v1.1）。

## Decisions

### D1 价目缓存模块的同步读面

`pricingFor(model)` 必须同步（recordTurnEvent 是同步缝）。实现：模块级 Map 缓存 + 定时器
（10min）全量刷新常用模型 + 未命中 fire-and-forget 补拉（下一回合起有价）。首启预热：server.js
初始化时对 ctx.dshModels 的全部模型 id 预拉一轮。

- 备选被否：appendTurnEvent 内联 async 拉价——写缝必须保持同步（事件本体的原子性优先）。

### D2 回合时刻价落在日行，不在 turn 行

turn 行只带 `pricing_at`（版本戳）；钱在日行——**估算成本在 appendTurnEvent 现场按当时的缓存
单价算出并直接累加进日行**，价目天内变更不重算历史（每回合的钱定格在它的时刻）。日行四分量
列（input/output/cache_write/cache_read USD REAL）+ `pricing_at`（该行最后一次有价回合的价戳）。

### D3 估算口径 v1 = 默认单价 ×1.0

组倍率/订阅折扣/effort 倍率都不进 v1 估算——**对账因子显式化它们**（factor = est/actual，
reconcile 输出）。v1.1 用观测因子校准每 owner 的系数。理由：key→user→subscription→group 的
链路属计费平面；平台侧推倍率是在重建词元的计费逻辑，必然漂。

### D4 对账面 = 运维脚本，不建 HTTP 面

`scripts/reconcile-turn-pricing.mjs`：pod 内 `node scripts/...` 直跑（fleet db 读面 + sub2api
admin 门）。输出 per-owner：est（有价样本）、actual（today_actual_cost）、factor、样本口径
（有价回合数/总回合数）。>30% 打 WARN。不建 ops-console 面（统计面 S4 的事，避免第二个要维护的面）。

### D5 pricing_at 的双落位语义

turn 行 `pricing_at` = 该回合所用价目表抓取时刻（NULL=无价）；日行 `pricing_at` = 该行最后一次
**有价**回合的价戳（NULL=整行无价样本）。聚合口径：cost 列只含有价样本贡献，turns 含全部——
有价样本量可由 (pricing_at 非空样本) 推出（若需精确列 v1.1 加 priced_turns）。

## Risks / Trade-offs

- [ 价目表热身窗口的头几回合无价 ] → 诚实 NULL + 启动预热；对账因子不因此失真（真数侧照记）。
- [ found:false 的模型（词元定价列表外）] → 与不可达同形（NULL），对账因子显式化；不猜测家族价。
- [ today_actual_cost 是「今日」口径，跨日对账需在当日跑 ] → 脚本文档写明；历史日的真数在
  词元 usage log（v1.1 需要时读趋势端点）。
- [ cost 列 REAL 累加浮点漂移 ] → 日粒度金额级累计，量级无关紧要；不搞分单位整数化（过度工程）。

## Migration Plan

1. 滚版后定价缓存启动预热；新回合开始带 pricing_at；旧行 NULL。
2. 验证：真机任一自然回合日行出 cost 列；对账脚本跑一遍出因子。
3. 回滚：镜像回滚即回退；新列留存无害。

## Open Questions

- 无阻塞项。peak_rate_multiplier（峰时倍率）v1 不计——对账因子会把时段效应显式化。
