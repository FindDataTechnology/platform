# 上游 PR 候选提交计划（词元 fork → Wei-Shaw/sub2api）

> 谱系纪律（ADR-0024 / spec「上游回馈优先」）：普适能力以独立可 cherry-pick 提交
> 推上游 PR，签署上游 CLA.md；上游合入后下一个月度窗退役本地对应补丁
> （fork diff 只许缩小方向的变更无需额外决策）。状态同步登记台账§五。

## 候选① 按 key 自助用量查询端点（对应上游 issue #6421）

**上游现状（2026-10-14 核实）**：issue #6421「[Feature] 提供按 API Key 维度的
用量/费用查询接口(接入方自助对账)」**open**（2026-08-31 最后更新），无关联 PR。
上游已有近邻端点 `GET /v1/sub2api/billing`（`gateway_key_billing.go` KeyBillingInfo，
返回该 key 的倍率/峰谷信息）——本候选=同端点族的用量维度扩展，形状应与之对齐
（`object: sub2api.*` + `schema_version` + `Cache-Control: no-store`）。

**平台侧动机**：ADR-0011 明确「day one 用量面板走 admin API」的欠账；有了自助
端点，平台/部署者/外部调用者可直接对账，不必给 admin key。

**提议形状（PR 时以 issue 讨论为准）**：

```
GET /v1/sub2api/usage?start=<RFC3339>&end=<RFC3339>&group_by=day|model|key
→ 200 {object:"sub2api.key_usage", schema_version:1,
        key:{id, name}, window:{start, end},
        totals:{requests, input_tokens, output_tokens, cost, actual_cost},
        buckets:[{bucket:"2026-10-14", requests, cost, ...}]}
```

- 数据源=既有 `usage_logs` 表按 `api_key_id` 聚合（上游内部已有 admin 用量查询
  可复用其聚合口径，见 `handler/admin/usage*`）；
- 鉴权=同 `/v1/sub2api/billing`（apiKeyAuth 链上、只读自身 key 数据）；
- 分页/窗口上限：与 admin 用量查询同口径（默认近 7 天、上限 31 天，对齐
  `UsageCleanupService` 的 max_range_days）。

**实施计划**：
1. 在 fork 仓从 `upstream/v0.2.16` 拉独立分支 `feat/key-usage-endpoint`（干净
   单提交，不夹带任何 lanes 代码）；
2. 实现+测试（复用 admin usage 聚合函数；契约测试镜像 `gateway_key_billing_test.go`）；
3. 本地/CI 全绿后推 **scs001 fork**（上游非真 fork 关系，PR 走 scs001 前例），
   `gh pr create -R Wei-Shaw/sub2api`，正文引用 issue #6421；
4. **先签 CLA**（上游 CLA.md，首次 PR 前）；PR 保持单提交、描述含动机/形状/兼容性；
5. 合入后：下一个月度窗删除 fork 内任何临时实现、台账§五状态改「已合入退役」。

**状态**：未启动（计划就绪）。**触发时机**：车道 v1 部署窗后（优先让生产先吃到
三车道，PR 是持续动作非门）。

## 候选② 虚拟用量端点（ADR-0014 backlog）

**语义**：让持有 admin 权限的调用方**代调用键写入**一笔用量/费用（「虚拟用量」），
用于外部结算通道（萬星门面 v1 的 adjustBalance 结算）切换为「sub2api 账本为
权威」——门面按（调用者, agent, 请求, 时长）计量后，不再调 adjustBalance 直改
余额，而是记一笔归属调用键的虚拟用量行，让 sub2api 原生账本/面板/窗口/硬顶
全部生效（ADR-0014 ③ 的切换前置）。

**提议形状（草案）**：

```
POST /api/v1/admin/usage/virtual   （admin 鉴权）
{api_key_id, model:"<虚拟模型名>", units:{...}, cost, actual_cost,
 idempotency_key, metadata:{caller, agent, turn_id}}
→ 201 {object:"sub2api.virtual_usage", id, applied:true}
```

- 幂等=必填 `idempotency_key`（门面重试不重复记账）；
- 计入 key 消费窗/余额硬顶/面板（走既有 RecordUsage 落账路径，`request_type`
  标 `virtual` 以与真实上游调用区分）；
- 单位面：v1 用金额（cost）+自由 `units` 描述（供面板标注），不引入新计量单位。

**实施计划**：同候选①流程；**前置**=候选①先合（两者共用 usage 落账口径与
面板展示语义），或至少与上游维护者先对齐语义（issue 先行）。

**状态**：未启动（计划就绪，等候选①）。**平台侧依赖**：ADR-0014 结算切账本
权威、ADR-0022 分成通道对账。

## 候选③ per-account 有界排队 + AIMD 自适应并发（对应上游无界等待病）

**上游现状（2026-11-05 核实）**：上游 `repository/http_upstream.go` 全部上游共享
一个 `MaxConnsPerHost=240` 的 transport；达到上限后新请求在 transport 内部队列
**无界等待**——一个坏上游（慢/403/挂死）占满连接池后，整池请求排队吞超时。
上游无任何 per-account 并发控制（`grep -l "AIMD|account_queue" upstream/main -- backend/`
零命中；`ConcurrencyConfig` 只管 SSE ping 间隔；`ImageConcurrencyConfig` 只管图片
生成入口数）。外部证据：上游 issue 区多次「一个账号挂了拖死其他账号」类报告
（如 Kimi 403 被误归类，`ratelimit_service.go:1013` 只做分类不隔离）。

**平台侧动机（实证）**：2026-10-27 词元配额事故（无界排队 3h 全平台断供）与
2026-10-27/11-01 两度「坏仓库 403 拖死 relay 锁三连」的代码级根因即此——故障窗口
内排队时长吞噬客户端超时，压力自我延续。

**提议形状（PR 时以维护者偏好为准；fork 内已全量验证）**：

- **per-account 有界信号量**：进 transport 前先过账号级 slot（bound=账号
  `Concurrency` 字段，缺省 env `UPSTREAM_CONCURRENCY_MAX=8`）；等待用唤醒式
  （cap-1 通知 + 兜底轮询——纯轮询在 8 等待者下不收敛，单测逮住）；
- **队列深度上限**：`UPSTREAM_QUEUE_BOUND`（缺省 bound×4）；队满 `ErrQueueFull`
  **快速拒**（HTTP 429 + `Retry-After`），failover 链把它当终止性信号
  （`NextAccountStop`）——不把过载压力推给下一个账号；
- **AIMD 容量状态机**（`UPSTREAM_AIMD_ENABLED` 开关，false=静态并发）：5xx 三连
  减半（下限 1）、429 作为容量信号收窄但不计连击、成功冷却 +1 恢复、
  closed/half_open/open 三态；上游 4xx 语义失败中性不喂点；
- **观测面**：`GET /admin/accounts/upstream-queue-metrics`
  （queue_depth / queue_rejected_total / aimd_concurrency / aimd_state）。

**实现位置（fork 内已验）**：新增 `repository/account_queue.go`（~340 行）+
`http_upstream.go` Do 入口接线（acquire/release + AIMD 记账）+ port
`RecordAIMDResult`（service→port→repo 依赖方向）+ 语义失败喂点
（`openai_account_runtime_block_fastpath.go`）+ 429 映射
（`openai_upstream_transport_error.go`/`mapUpstreamError`）。**零 schema、零对外
契约变化**；压测实证：5xx 风暴注入下 56091 次 queueFull 快拒零堆积、全 worker
3s 内自然返回、AIMD bound≤limit 守恒。

**上游化拆分**：单 PR 提 `account_queue.go` + `http_upstream.go` 接线（核心）；
AIMD 状态机与观测面可拆后续 PR（维护者若嫌重，先收有界排队+429 快拒即可解
拖死病——AIMD 是锦上添花）。

**状态**：fork 已全量落地（fork 补丁级 17，add-sub2api-fork-concurrency，压测+
单测全绿），未启动上游 PR（等月度窗后按通用纪律拆提交）。

## 通用纪律（三候选共用）

- **单提交、cherry-pickable**：分支从 `upstream/v0.2.16` 起，不含 lanes/平台清单
  等 fork 专属内容；
- **CLA 先行**：上游 CLA.md 签署一次，覆盖后续 PR；
- **不夹带**：PR 内不引用词元内部文档；动机用普适语言（上游视角的用户价值）；
- **退役登记**：合入→月度窗删除本地对应实现→台账§五+§一备注；
- **候选新增**：fork 内发现普适能力（如三车道沉淀的通用错误面/多上游池形态）
  随时追加到本文件与台账§五。
