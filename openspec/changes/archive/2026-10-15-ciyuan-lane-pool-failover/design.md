# Design — 车道池 v1.1（轮转冷却 + websearch BYOK）

## Context

车道池 v1 `Pool.Pick` 取 `ListSchedulableByPlatform` 首个 active 即返回（fork
`pool.go:57-70`），失败无冷却无换账号。上游地基现成：repo 接口已有
`SetTempUnschedulable/ClearTempUnschedulable`（`account_service.go:106-108`），
`ListSchedulableByPlatform`（`account_repo.go:2129`）已按
`temp_unschedulable_until/overload_until/rate_limit_reset_at` 过滤并按
priority ASC 排序；车道池持有的就是完整 `AccountRepository`
（`LanesAccountRepo()` 缝点，`openai_gateway_service.go:1285`）——**冷却读写
链路零新增缝点、零 schema 变更**。search-relay 的分级口径（`isExhausting`：
额度/auth 类 12h、瞬态 60s）为对齐基准。

## Goals / Non-Goals

**Goals**
- 三车道共用一套候选遍历 + 失败分级冷却 + 换号重试。
- websearch BYOK：请求级用户 key 优先、失败回退池、来源三态标注、0 费计量。
- 冷却状态 admin 可见（复用账号健康面既有展示，不新增 UI）。

**Non-Goals**
- 不做按并发/负载的智能调度（priority 顺序遍历已满足转售池场景）。
- 不动对外协议形状（统一信封、错误面、鉴权链均不变）。
- 不做 rerank/audio 的 BYOK（上游供应商无请求级 key 语义的先例，等有需求再说）。
- 不含 search-relay 切换（另 change `search-relay-via-ciyuan`，本 change 是其前置）。

## Decisions

**D1 冷却写 `temp_unschedulable` 而非进程内 Map** — 跨重启、admin 面可见、与
chat 网关同一健康模型；代价是每次失败一次 DB 写。备选进程内 Map（relay 现状）
被否：pod 重启即失忆、运维盲。写失败不阻塞换号重试（best-effort，记日志）。

**D2 分级判据对齐 relay 的 `isExhausting`** — HTTP 401/402/429 或错误文本匹配
额度/account/api key 字样 = 长冷却 12h；其余（网络错、超时、5xx）= 短冷却 60s。
判据放 `errors.go` 单点，三车道共用；上游错误文本**只进判据不进响应**（既有
不外泄纪律）。

**D3 `Pick` → `Candidates(ctx, platform) ([]Account, error)`** — 返回全列表，
遍历与冷却决策在适配器层（各车道对「成功」的判定不同：rerank 看 JSON 形状、
audio 看流式 200、websearch 看 organic_results）。备选把 retry 循环收进 Pool
被否：会要求 Pool 理解各车道协议，破坏适配器边界。

**D4 BYOK 计量 0 费** — 用量行照记（`WebSearchCalls=1` + source 标记），但走
`CalculateRerankCost` 式 0 价分支：BYOK 笔的 key 侧计费=0，账号字段标
`byok:<hash8>`（对齐 relay 的 sha256 前 8 位归因，不落 key 值）。备选「BYOK
不计任何量」被否：丢失归因与用量可见性。

**D5 BYOK 判定 key 有效性** — BYOK 失败同样分级冷却（按 hash 前缀，进程内
Map 即可——BYOK 是请求级凭据，无 Account 行），失败后回退池并标
`pool-after-user-failure`。

## Risks / Trade-offs

- [单账号池下轮转无感] → 部署后立即补第二枚 SerpAPI key（admin 加账号行即可，
  无需发版）；本 change 让这件事从「无效」变「有效」。
- [冷却 DB 写放量（上游全挂时每请求一次写）] → `SetTempUnschedulable` 幂等且
  带 until 覆盖语义；再加写节流（同账号+同 reason 60s 内不重复写）。
- [BYOK 头被中间层剥] → 词元是 TLS 终点直连，无此层；但 relay 切换 change 里
  要显式透传该头（那边的 tasks 里有对应项）。
- [12h 冷却误伤瞬态 429] → SerpAPI 429 文本区分「额度尽」与「并发限」；判据
  命中「run out of searches/account」才 12h，裸 429 落 60s。

## Migration Plan

1. fork 仓实现 + 单测（fake AccountLister/CooldownWriter 覆盖轮转/分级/BYOK 三态）。
2. CI：law-ai 快照线（先本地全量，再推快照省额度）；出 `ciyuan-v0.2.16-5`。
3. 部署滚 sha tag；验收=①池空 503 形状不变 ②正常笔计费不变 ③（可选）admin
   加第二 key 后手动停一号验证换号。
4. 回滚=滚回 `sha-8dc08e1`（纯新增行为，无数据迁移）。

## Open Questions

- admin 加第二枚 SerpAPI key 的时机（部署后即加，还是等 relay 切换一起）——
  不影响本 change 验收，运维节奏问题。
