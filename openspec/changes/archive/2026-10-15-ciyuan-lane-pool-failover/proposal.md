# 词元车道池 v1.1：多账号轮转冷却 + websearch BYOK 覆盖

## Why

车道池 v1 的 `Pick` 只取列表首个 active 账号（fork `pool.go:57-70`），失败不冷却、
不换下一个——单 key 额度一尽整个车道硬失败。生产 websearch 车道已单 key 运行
（SerpAPI 账号 #37），额度耗尽即 503，比它要取代的 search-relay（12h/60s 两级冷却
+轮转）弱。同时 search-relay 的 BYOK（`X-Serpapi-Key` 请求级覆盖，add-search-byok
已在产）车道没有——后续 search-relay 上游切词元（change `search-relay-via-ciyuan`）
会砍掉该能力。本 change 是那条收口线的**前置**，也独立修复外部消费者的单点缺陷。

## What Changes

- **池改候选遍历**：`Pick` → `Candidates`（按 priority 稳定序全列表）；三个车道
  适配器（rerank/audio/websearch）失败时换下一个账号 retry，全池尽才 503。
- **失败分级冷却**：复用上游 `SetTempUnschedulable`（`account_service.go:106`）——
  额度/auth 类（401/402/429/"run out of searches"）冷却 12h，瞬态类冷却 60s，
  口径对齐 search-relay 的 `isExhausting`。冷却落 DB（`temp_unschedulable_until`），
  跨重启、admin 账号面可见——优于 relay 的进程内 Map。
- **websearch BYOK 覆盖**：车道接受 `X-Serpapi-Key` 请求头——用户 key 优先直连
  上游、失败回退池、`x-search-source: user|pool|pool-after-user-failure` 三态
  如实标注（对齐 relay 语义）。BYOK 笔**计量 0 费**（用量行保留，归因可见），
  不经账号池、不产生平台计费。
- **不新增 schema、不改对外协议形状**（统一信封/错误面不变）；纯新增行为，
  可独立回滚。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ciyuan-gateway-lanes`：新增两条 requirement——①车道上游池多账号轮转与失败
  分级冷却（全池尽才 5xx）；②websearch 车道 BYOK 覆盖（用户 key 优先+回退池+
  三态标注+0 费计量）。既有 requirement 不动。

## Impact

- **实现落 fork 仓**（`~/finddata/sub2api`）：`backend/internal/lanes/pool.go`
  （Pick→Candidates）、三适配器 retry 循环、`errors.go`（冷却分级判据）、
  websearch.go BYOK 分支；service 访问器缝点（handler 只读 getter）需加
  `SetTempUnschedulable` 透出——**缝点表要登记新增缝点**。
- 上游 `ListSchedulableByPlatform` 已过滤 `tempUnschedulable/overload/rateLimit`
  冷却字段（`account_repo.go:2129`），零改动复用。
- 台账 `docs/sub2api-fork-patches/README.md` §二 缝点表 + §一 发布记录。
- CI/出片：law-ai 快照线（月度余 ~320 分钟，单次全绿 13-14 分钟）。
- 下游依赖：`search-relay-via-ciyuan` change 以本 change 为前置。
