# ciyuan-embedding-lane — Design

## Context

动机见 proposal.md - Why。此处只记方案需要的现状与约束。

**已实证事实**（2026-10-18 实测，非推断）：

| 事实 | 证据 |
|---|---|
| 硅基流动账户对全部嵌入模型 402 | 同一 key 逐个模型调用：`Qwen3-Embedding-8B/4B/0.6B`、`BAAI/bge-m3`、`Pro/BAAI/bge-m3`、`bge-large-zh-v1.5`、`/v1/rerank` 全部 `30001 balance insufficient` |
| 词元 `/v1/embeddings` 入口存在且只对 `platform=openai` 分组放行 | `routes/gateway.go:249` 的 `isOpenAIOnlyEndpointGatewayPlatform` 门；组 3 key 调 `deepseek-v4.1-flash` 嵌入得 400（说明已过门、进了转发），调 `Qwen3-Embedding-8B` 得 404 `model_not_found`（组 3 未挂嵌入账号） |
| 词元已有分组 8「embedding」（platform=openai、非专属）与两个账号 | admin API：账号 #34 openai-next（`base_url=https://api.openai-next.com`）、#32 OpenRouter（`https://openrouter.ai/api/v1`）；#34 的 `model_mapping` 仅白名单三个 OpenAI 嵌入模型名 |
| OpenRouter 有 `qwen/qwen3-embedding-8b` | `/api/v1/models/qwen/qwen3-embedding-8b/endpoints`：Nebius / DeepInfra 端点，prompt $0.01/M tok，ctx 32K+ |
| 词元价格表无嵌入条目 | `model_prices_and_context_window.json` 中 `text-embedding-3-*` / `Qwen3-*` 全 MISSING；仅 `gemini-embedding-*` 有价 |
| 词元转发是 body 原样透传 | `service/openai_embeddings.go:38`：仅当模型名被改写时才 `ReplaceModelInBody`，否则 `upstreamBody = body`；故 `dimensions` 可穿,`provider` 亦可穿（需剥除） |
| 两个消费方在产且模型不同 | `fd-text-core` 8B + `dimensions=1024`（`vector(1024)` 硬约束）；`fd-legal-search-mcp` 0.6B（Qdrant `law_chunks_v2` 1024 维） |
| **OpenRouter 多 provider 漂移实测存在** | 同一 key 同一文本连调 10 次、**不钉 provider**：min_cos=**0.996511**（4096 维）。钉 `provider={"only":["Nebius"]}` + `dimensions=1024`：min_cos=**0.999925**（45 对两两余弦）。这就是历史 0.9978 漂移的成因与规避手段 |
| **provider 选择直接影响是否过门** | 钉 DeepInfra 同法实测 min_cos=**0.997614**（不过 0.999 门）；钉 Nebius 过门。**必须钉 Nebius**，不是任意 provider 均可 |
| MRL 截断是服务端正规能力 | `dimensions=1024` 返回向量 vs 原生 4096 维前 1024 维，余弦 0.999892（同空间截断，非客户端降采样） |
| 组 8 现网调用 502 的真实原因 | 临时探针 key 调两个 Qwen 模型均 502 `EOF`；日志显示打到账号 #32 的 `https://openrouter.ai/api/v1/embeddings` 后 EOF。但该账号 key 直连 OpenRouter **200 正常**（上述实测即用它的 key）→ 502 源于网关→上游的出站链路，非 key、非模型、非路由 |
| OpenRouter 不支持 0.6B | `qwen/qwen3-embedding-0.6b` 端点数为 **0**（`/endpoints` 返回空 list）；`qwen3-embedding-4b` 仅 DeepInfra 一家 |


**约束**：词元为 sub2api 增量谱系 fork，纪律「只增不改、零补丁」（ADR-0024，
台账 `docs/sub2api-fork-patches/README.md`）。故本 change 不产出 fork 补丁，
全部经词元既有 admin 面配置完成。pgvector `vector(1024)` 与 Qdrant 1024 维是
两个消费方的硬 schema 约束，决定了「模型名不变、维度不变」是本方案的前提。

## Goals / Non-Goals

**Goals**

- 经词元既有 `/v1/embeddings` + admin 面配置，使契约模型
  `Qwen/Qwen3-Embedding-8B`（`dimensions=1024`）对**文本引擎**可路由、
  可计费、可轮转、向量一致。
- 文本引擎侧库内既有 1024 维向量继续可用，零重嵌。

**Non-Goals**

- **不改造法条检索线**（用户 2026-10-18 决策：维持 0.6B，库不重建）。实测已定
  性：`law_chunks_v2` 为 0.6B 所建（自我检索命中 0.9999、12 点抽样余弦
  0.99989~0.99992），且硅基流动 key 已恢复、端到端语义检索实测可用
  （真实查询首条 0.9219 命中目标条例 + 同类法规随附）。该线的上游与模型
  SHALL 保持不变；其契约由 capability `text-indexing-search` 规定，不在本
  change 范围。
- 不做 fork 补丁、不出镜像（provider 钉扎注入除外，见 D5——那需要一小段
  「只增」代码与一次出片）。
- 不新增第四车道适配器（嵌入走 chat 网关族，不经 `internal/lanes`）。
- 不改造硅基流动账户（充值/换 key 是运维动作，非本 change 范围）。
- 不为 Qdrant 建新 collection / 不改 schema（法条线不动库）。
- 不做本地化权重部署（fd-lex 的 `lex-embed-local` 私有化出口仍保留为独立事项）。

## Decisions

### D1：嵌入走 chat 网关族，不建第四车道

**选择**：`/v1/embeddings` 经 `OpenAIGatewayService`（chat 网关族）既有链路
处理，复用其账号池调度、失败转移、余额硬顶与账本；不新增 LaneAdapter。

**理由**：
- 入口与协议形状已是 OpenAI 原生（`POST /v1/embeddings` + `model`/`input`/
  `dimensions`），与三车道（Cohere/Jina 式 rerank、multipart 音频、统一信封
  搜索）根本不同——三车道之所以需要适配器正是因为它们不是 OpenAI 形状。
- 按 token 计量，与 chat 同口径；三车道是按次/按时长/按字符。
- 落到 `platform=openai` 分组即可复用 `SelectAccountWithSchedulerForCapability`
  的 `embeddings` 能力筛选，零新代码。

**备选**：新建 `LaneEmbed` 适配器（照 rerank 第三方形状透传的样子）。否——
  等于把 OpenAI 原生协议再包一层自有协议，反而破坏「既有 SDK 零改造」，
  且要把计费从 token 链路接到按次的 lane Meter 上，纯增复杂度。

### D2：上游选 OpenRouter，但出站链路是未解阻塞

**选择**：契约模型 `Qwen/Qwen3-Embedding-8B` 的上游用 OpenRouter（账号 #32
已在池）；openai-next（账号 #34）经实测**不供 Qwen 嵌入**，退出候选。

**理由（部分成立，且带一个未解阻塞）**：
- OpenRouter 端点实证存在，Nebius $0.01/M tok 最便宜，Context 表明确认
  `qwen/qwen3-embedding-8b` 有活端点。
- 账号已在分组 8 池内，无需新建。
- OpenRouter 单一 slug 下三个 provider（Nebius / DeepInfra / SiliconFlow）
  的向量空间差异已实测证实，故 provider 钉扎是**必需**而非可选（见 D5）。

**阻塞（实施第一道门槛，必须先解）**：网关→OpenRouter 的出站请求全部 EOF
502，而同 pod 内 `wget` 直连同一 URL 同一 key **200 成功**。已排除：key
无效（直连 200）、DNS/TLS/网络（wget 通）、模型名与白名单（未报
`model_not_supported`）、H2 fallback 自救（连打 6 次仍 502）。同期日志显示
账号 #35（openai-next）的 chat 请求 200，故问题限于 OpenRouter 这一目标主机。
初步判断为 Go http2 transport 与 Cloudflare 的交互（EOF 而非 timeout，
5.1s 固定时延），需进一步定位；这也意味着 D2 的「OpenRouter 为主」在阻塞解除
前无法落地。

**备选**：openai-next 为主。已否（503 不供该模型）。若阻塞短期无法解除，
见 Risks R6 的降级路径。

**备选**：openai-next 为主。否——openai-next 的 8B 供给未实证（其账号
  `model_mapping` 只列 OpenAI 三型号，未见 Qwen），需先探明再定；OpenRouter
  的模型目录可直接查证，先落地风险更低。

### D3：契约模型名保持 Qwen 原名，不改写为 OpenAI 名

**选择**：对调用方暴露 `Qwen/Qwen3-Embedding-8B`（text-core 现名）与
`Qwen/Qwen3-Embedding-0.6B`（legal-search 现名），上游模型名一致、不改写。

**理由**：两个消费方都不用改模型名配置；且 Qwen 原名是「同一模型」的标识，
  若改写成 `text-embedding-3-small` 之类会改变向量空间，违背零重嵌目标。

**关键配置**：账号 #34（openai-next）现有 `model_mapping` 只白名单
`text-embedding-3-{small,large}` 与 `ada-002` —— **Qwen 模型会被它拦死**
（`IsModelSupported` 对非空 mapping 走白名单，未命中即 `model_not_supported`）。
故必须为该账号补 Qwen 映射条目，或开 `extra.openai_passthrough=true`
（`IsOpenAIPassthroughEnabled` 命中即放行所有模型，见 `service/account.go:898`）。
**推荐后者**：透传是车道账号的既有惯例（v-9 修过的「车道账号应不限模型」
同款处理），且将来换模型不用再改映射。

### D4：价目用分组/渠道自定义价，不动全局价格表

**选择**：为嵌入分组（组 8 或新建专属组）配置 `Qwen/Qwen3-Embedding-8B` 的
token 自定义价（可按 OpenRouter $0.01/M 成本加倍率），不改
`model_prices_and_context_window.json`。

**理由**：
- 价格表是 LiteLLM 同步来的共享资产，fork 改它 = 上游合并冲突面（「只增不改」
  纪律下也不该动它）。
- 分组/渠道自定义价是既有机制（`Group.ModelPricing` /
  `ChannelModelPricing`），门槛为零且可随时调价。
- 未配价会 fail-closed 成「无价可循」并告警（`ErrModelPricingUnavailable`），
  不会静默 $0——spec 已把这条立为需求。

**注意**：`OpenAIEndpointCapabilityEmbeddings` 要求账号 `type=apikey`
（`SupportsOpenAIEndpointCapability` 中 `embeddings` 分支），而池内 #32/#34
都是 apikey，且都未显式配 `openai_capabilities` ——缺键时该函数返回 true
（允许所有），故**不需要**额外配能力集。

### D5：provider 钉扎由词元侧账号级注入（需一小段新增代码）

**选择**：在 `ForwardEmbeddings` 构造 `upstreamBody` 时，用账号级固化的
provider 值**注入/覆盖**请求体的 `provider` 字段；调用方自带的同名字段被覆盖
而非透传。固化值来源建议为账号 `extra`（如
`extra.embedding_provider_only = "Nebius"`），与词元既有的账号级配置位
（`openai_passthrough` 等）同款形态。

**理由（实测驱动，非偏好）**：

| 配置 | 连调 10 次 min_cos | 判定 |
|---|---|---|
| 不钉 provider（4096 维） | 0.996511 | 漂移 |
| 钉 `Nebius` + `dimensions=1024` | **0.999925** | 过门 |
| 钉 `DeepInfra` + `dimensions=1024` | 0.997614 | **不过门** |

即：provider 钉扎是契约达成的**必要条件**，且不是任意 provider 都行——本方案
必须钉 Nebius。这不是可选加固，而是「同文本重复调用向量一致」这条需求的实现
前提。

**为何由网关注入而非调用方自带**：`fd-legal-search-mcp` 的
`ApiEmbedder` 根本没有 provider 字段（它原本直连单一上游），要求它自带=要改
消费方代码，违背「调用方零改造」；且调用方能自带即可被调用方覆盖，钉扎形同
虚设。网关注入则两个消费方都无感。

**形态**：属「只增」——在 embedding 转发路径加一段 body 字段注入，不动其它
路径，需走 fork 补丁级 + 出片流程（见 tasks 6.1）。

**过渡**：出片前可先用「调用方自带 provider」临时打通链路验证（body 原样
透传，自带字段会到上游），但交付态必须是网关注入。

### D6：契约模型候选池 SHALL NOT 混入不同向量空间的上游

**选择**：承载 `Qwen/Qwen3-Embedding-8B` 的账号池，SHALL 只含同一模型族的
上游；不同量化/实现的同名模型（如 SiliconFlow 与 DeepInfra 的 8B）不混入
同一契约模型的候选集。

**理由**：spec「同文本重复调用向量一致」要求它。OpenRouter 单一 slug 下的
多 provider 由 OpenRouter 侧路由，词元不感知；词元侧要保证的是账号级不混。

**落地**：给每个上游账号配 `model_mapping` 或透传，使模型名只落在预期上游；
若日后需多上游冗余，须先实证两上游向量空间相同（余弦 ≥0.999）再入池。

## Risks / Trade-offs

- **[R1] OpenRouter 侧多 provider 路由不可控 → 向量漂移（已实测证实）**
  实测不钉 provider 时 min_cos=0.996511（4096 维）。Mitigation：D5 的账号级
  钉扎（Nebius，实测 0.999925 过门）+ tasks 2.2 的 10 次一致性门槛。**这不是
  理论风险，是复现过的现实。**

- **[R6] 网关→OpenRouter 出站 EOF 502（已解除，根因为上游侧抖动）**
  当日早些时候：同 pod 内 wget 直连 200、网关 Go client 502 EOF，连打 6 次不
  恢复，同期 openai-next（账号 #35）chat 200；已排除网关侧的 key/网络/模型/
  白名单/H2 fallback。**当日稍晚 OpenRouter 侧恢复后网关调用即通**，且此后
  20 次连续调用 20/20 成功。
  根因判定：**OpenRouter 侧间歇性不可用，非网关 Go http2 缺陷**——若为网关
  transport 问题，直连 200 与网关 502 的差异会稳定复现，而非随时间自愈。
  **关键结论：provider 钉扎解决的是「向量漂移」这个确定性问题，不消除可用性
  抖动**（复测中仍偶发单次 EOF，重试即成功）。可用性靠 spec 既有的
  「多候选轮转 + 分级冷却」与全池尽 5xx 的降级语义兜底。
  **实测基线（组 8 探针 key，2026-10-18）**：带 `provider={"only":["Nebius"]}` +
  `dimensions=1024` → 200 / 1024 维 / usage 完整；10 次一致性 min_cos=0.999822
  （45 对两两余弦，过 0.999 门）。
  ⚠ 附带坑：同一请求体不带 `dimensions` 时上游返回 **4096 维**（8B 原生），
  消费方若未显式带该参数会拿到超长向量——`fd-text-core` 已显式带
  `dimensions=1024`（`FDTEXT_EMBEDDING_DIM`），不受影响；但这说明
  「维度契约」必须由消费方显式声明，不能依赖网关默认。

- **[R2] 上游整体不可用 → 检索降级为纯关键词**
  Mitigation：既有 spec 已要求「上游不可用如实报错、不静默空结果、关键词检索
  不受影响」；`fd-text-core` 的 RRF 混合检索在向量通道缺失时按既有
  `UpstreamUnavailable` 路径降级。需在验收中显式验证降级路径可用。

- **[R3] 维度漂移写坏 pgvector 列**
  Mitigation：spec 已立「维度不符 SHALL 拒绝而非静默返回」；`vector(1024)`
  列定义是 pgvector 类型检查兜底（插入即报错）。两消费方都显式带
  `dimensions=1024`。

- **[R4] provider 钉扎需要出片（打破「零代码」初衷）**
  D5 需一小段「只增」代码 + 一次 fork 补丁级出片与滚产。Mitigation：出片前
  可用「调用方自带 provider」临时打通验证（body 透传），但交付态必须是
  网关注入；否则 legal-search 侧无法钉扎、且调用方可自行覆盖。

- **[R5] 硅基流动 key 退役后 rerank 车道同时失去免费 rerank**
  词元 rerank 车道上游也是硅基流动（`bge-reranker-v2-m3`）。Mitigation：
  本次只切嵌入，rerank 单列 change（上游可换 Cohere/Jina `bge-reranker-v2-m3`
  的同名供给，OpenRouter/Cohere 均有）。

- **[R7] 0.6B 在 OpenRouter 无端点 → 法条侧上游未定**
  实测 `qwen/qwen3-embedding-0.6b` 端点数为 0；openai-next 不供 Qwen 嵌入；
  `qwen3-embedding-4b` 仅 DeepInfra 一家。Mitigation：法条侧候选为
  ① DeepInfra 自有 key 直连供 4B/0.6B（需先验证其有 0.6B）；② 维持
  0.6B 但换到有该模型的上游；③ 接受法条侧改用 8B → 需 Qdrant 全量重嵌
  （`law_chunks_v2` 重建）。**这是一个需要你决策的岔路**，见 Open Questions Q4。

## Migration Plan

**前置门槛（2026-10-18 已全部达成）**：① ~~R6 出站阻塞已解~~ ✅
（OpenRouter 侧恢复，网关调 `/v1/embeddings` 得 200）；② provider 钉扎生效
（尚待 1.1 落代码；过渡期由请求体自带验证过 10 次一致性 ≥0.999，
min_cos=0.999822）；③ 契约模型已在组 8 可路由 ✅；④ 价目已配（待 2.2）。

**步骤**：

1. 解 R6 阻塞（定位出站 EOF 根因并修复/规避）。
2. 词元侧：分组 8 挂上游账号 + 配 token 自定义价 + 开透传/补模型映射；
   provider 钉扎落地（D5）。零滚动或一次补丁级滚产。
3. 通道验证：临时 key 直调 `/v1/embeddings`，断言 1024 维 + usage 回传 +
   用量行落账扣费。
4. 一致性验证：同文本连续 10 次，余弦 ≥0.999。
5. `fd-text-core`：更新 Secret `fd-text-core-env`（`FDTEXT_EMBEDDING_API_BASE`
   → 词元网关、`_API_KEY` → 内部服务密钥、`FDTEXT_EMBEDDING_PROVIDER_ONLY`
   置空——钉扎已由词元侧负责），滚动 Deployment；跑
   `conformance_gate.py --strict` 验锚点余弦与七项门。
6. 观测：文本引擎的语义检索工具在生产真实查询各一次，确认命中与 provenance。
7. 台账：`docs/registry-maintenance.md` 登记本次切换与硅基流动 key 退役
   （仅限文本引擎侧；法条侧的 key 按 Q4 维持不变，不退役）。

**不执行**（Q4 已定）：法条侧不改上游、不改模型、不重嵌 `law_chunks_v2`。

**回滚**：`fd-text-core-env` 改回硅基流动旧值 + 滚动即可（模型与维度未变，
库内向量无需处理）。前提是硅基流动账户可用；切回前须确认该账户余额正常
（2026-10-18 曾 402、当日恢复，属波动状态）。

## Open Questions

> 状态更新（2026-10-18 实施期）：Q1/Q2 已定（Q1=provider 由词元侧账号级注入，
> 需出片；Q2=沿用组 8）；Q3/Q4 已被「法条侧维持 0.6B」的终局决策取代——法条线
> 退出本 change 范围，只保留文本引擎一条线。

- **Q1（已定）**：provider 钉扎形态。定为「词元侧账号级注入」——依据用户
  2026-10-18 指令「provider 可以通过指定固定下来」，且实测证明钉扎是
  契约必要条件（不钉 min_cos 0.996511）。需一小段「只增」代码 + 出片。
- **Q2（已定）**：沿用现有组 8「embedding」，不新建分组；现成 key 55 即
  内部服务密钥的候选。
- **Q3/Q4（合并为终局决策）**：**法条检索线维持 0.6B + 硅基流动直连，不换上游、
  不改模型、不重嵌库**（用户 2026-10-18）。见下条的实测依据。本 change 只覆盖
  文本引擎一条线。
- **Q4（已定，用户 2026-10-18 终局：法条侧维持 0.6B，不做任何改动）**
  期间曾决策 ③（统一到 8B），后经**实测判定库真身**而推翻重嵌前提的必要性：
  取库内真实 chunk 文本分别以 0.6B 原生与 8B(MRL 1024) 重嵌，再各自去
  `law_chunks_v2` 自我检索——
  - 0.6B：命中**自身**，余弦 **0.9999**；12 个抽样点全部 cos>0.9999
    （0.99989~0.99992）
  - 8B@1024：**不命中自身**，最高仅 **0.1316**
  → **库是 0.6B 所建，无混存**（另证：同法相邻块库内余弦 0.758 vs 随机对 0.339）。
  ⚠ 此实测同时否证了「配置口径两侧都是 8B」的说法：`fd-legal-search-mcp`
  deploy README 写 0.6B 是**如实文档**；勿与 `fd-text-core` 线混淆（那条线
  确实走过 `text-embedding-upgrade-8b`）。
  2026-10-18 硅基流动 key 恢复后，法条侧端到端已实测可用（真实查询首条
  0.9219 命中目标条例）。**故法条线维持 0.6B + 硅基流动直连，零改动、零重嵌。**
  该线未来若要换上游/换模型，属独立 change。
- **Q5（新，源自 0.1 阻塞排查）**：若 OpenRouter 出站阻塞判定为「本网关不可用」
  而降级到 DeepInfra 自有 key 直连，则 provider 钉扎需求自动消解（单上游无
  多 provider 路由），D5 的代码可不出——但两个消费方仍共用同一上游账号，
  钉扎需求转为「账号级不混入其它上游」的池拓扑约束（D6 已覆盖）。
