# Tasks: add-pack-usage-telemetry

## 1. 数据层

- [x] 1.1 主库新表 `pack_usage_events`（ts 索引、pack_id 可空）+ 180 天定时修剪（timer + incremental vacuum），验证单测：建表幂等、修剪只删窗 外行、回收生效

## 2. 打点

- [x] 2.1 `finishTurn` 钩子：user/session/agentId/outcome/duration 落行，pack 归属经 catalog 解析、local/自建→NULL、解析失败记 NULL 不丢行，全程 try/catch，验证单测：pack 行/NULL 行/写失败不破回合

## 3. 聚合面

- [x] 3.1 `GET /api/ops/pack-usage?days=`（days 夹取）：per pack turns/distinct users/lastUsed + packless 单列；ops 凭据门（无/错凭据 401 无数据），验证单测：聚合正确、门禁两态

## 4. ops 台

- [x] 4.1 services/ops-console「内部 pack 用量」板块（周活 pack 数 + 明细行），数据通道按 D5/D6 就近接既有源模式，验证：render 走查（沿 test-ops-console-board.mjs 先例或人工核）

## 5. e2e 与上线

- [x] 5.1 e2e：装 pack → 选专家 → 一回合 → 聚合端点见该 pack 行（fast 车道），验证 e2e 过
- [x] 5.2 全量单测绿 + 推送 scs001 CI 绿 + 出片，验证 CI 步骤级结论
- [x] 5.3 上线随下个 platform 滚动窗口：in-pod 实证表在 + ops 台板块可见 + 冒烟一回合见行，验证三处一致
