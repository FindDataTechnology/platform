# Tasks — ciyuan-lane-pool-failover

## 1. 池候选遍历（fork 仓 backend/internal/lanes）

- [x] 1.1 `pool.go`：`Pick` → `Candidates(ctx, platform)` 返回全列表（ListSchedulableByPlatform 已过滤冷却字段+priority 序）；保留 ErrNoLaneAccount 语义给空池。验证：`pool_test.go` 新增多账号候选序用例过绿。
- [x] 1.2 `pool.go`：新增 `AccountCooldownWriter` 小接口（SetTempUnschedulable + 写节流 helper：同账号同 reason 60s 内不重复写），Pool 持有；`NewPool` 签名兼容（repo 已满足接口）。验证：编译过 + 节流单测。

## 2. 失败分级判据（单点）

- [x] 2.1 `errors.go`：`classifyLaneUpstreamFailure(status int, upstreamBody string) (exhausting bool)`——对齐 relay `isExhausting` 口径（401/402/429 或「run out of searches/account/api key」文本=12h；其余=60s）；裸 429 不带额度字样落 60s。验证：表驱动单测含 SerpAPI/硅基/openai-next 三家真实错误样例。

## 3. 三适配器接入 retry 循环

- [x] 3.1 `rerank.go`：候选遍历——单账号失败按 2.1 分级写冷却（best-effort）换下一候选；全尽走既有 laneUpstreamError。验证：rerank_test.go 加「首号 402 → 二号成功」「全池尽 503」两例。
- [x] 3.2 `audio.go`：同 3.1（ASR/TTS 两入口共用循环）。验证：audio_test.go 同两形态用例。
- [x] 3.3 `websearch.go`：同 3.1。验证：websearch_test.go 同两形态用例。

## 4. websearch BYOK 覆盖

- [x] 4.1 `websearch.go`：`X-Serpapi-Key` 头——BYOK 优先直连（不进池）、失败按 hash8 进程内冷却并回退池、`x-search-source` 三态响应头。验证：websearch_test.go 三态各一例 + key 值不进日志/错误断言。
- [x] 4.2 BYOK 笔计量 0 费：`meter.go` 加 source 透传，`openai_gateway_usage.go` BYOK 分支计 0（用量行保留、account 标 `byok:<hash8>`）。验证：meter_test.go 断言 WebSearchCalls=1 且费=0。

## 5. 门与出片

- [x] 5.1 CI 测试门（用户硬规则=Go 不本地跑）：law-ai 额度实尽（5s payments-failed）→ 测试门搬 build-pool（workflow 补 test job 钉 go 1.27.0）；快照 testaction001/build-pool run 全绿即出 `ciyuan-v0.2.16-5`（ciyuan-tag 已改，commit f955c3fba/快照 f13040a）。
- [x] 5.2 部署滚 sha tag + 探针四件套全过（/health 200、version 自报 ciyuan-v0.2.16-5、公网门面+车道鉴权链统一 401、panic 扫零）+ 台账 §一登记；真实计费笔回执挂 change B 切换窗（内部 key 建立即打）。缝点表=零新增缝点（池本就持完整 AccountRepository）。
- [x] 5.3 轮转真回路实证（2026-10-15，用户授权用保存的 key）：临时插耗尽旧 key 账号（priority=0 先选）→ 请求 200 由 #37 完成，坏号落 12h 冷却（reason=quota/auth failure status 429），探针账号测毕即删。BYOK 三态真回执 + 用量行 93735 `byok:55faa0c2` 0 费落地（v-6 外键修复后）。
