# ciyuan-embedding-lane — 词元对外供给 OpenAI 兼容嵌入能力

## Why

硅基流动（SiliconFlow）账户曾对全部嵌入模型返回 402 `account balance is
insufficient`（实测 2026-10-18：`Qwen3-Embedding-8B/4B/0.6B`、`BAAI/bge-m3`、
`Pro/BAAI/bge-m3`、`bge-large-zh-v1.5` 及 `/v1/rerank` 无一可用），当时舰队两个
在产嵌入消费方（`fd-text-core` 文本引擎、`fd-legal-search-mcp` 法条语义检索）
同时停摆。**事后进展**：法条线经实测判定其库为 `Qwen3-Embedding-0.6B` 所建，
且账户余额当日恢复，端到端语义检索已实测可用，故用户决策该线维持原状；
本 change 因此收窄为**只把文本引擎切到词元**，使单一上游依赖变为可轮转、
可计费、有故障转移的平台链路。

词元（萬星·词元）已有 OpenAI 兼容 `/v1/embeddings` 入口与账号池调度能力，
且 OpenRouter 可服务 `Qwen/Qwen3-Embedding-8B`（端点实测存在：Nebius /
DeepInfra / SiliconFlow 三家，前两家 $0.01/M token）。把文本引擎的嵌入纳入
词元既有分组与账本，调用方只需换 `base_url` + key，模型名与维度不变，
即可**零重嵌**完成切换——这是本 change 的核心价值。

## What Changes

- **新增能力 `ciyuan-embedding-lane`**：词元经既有 `/v1/embeddings` 入口对外供给
  OpenAI 兼容嵌入能力，走既有账号池调度、失败转移、余额硬顶与原生账本；
  上游账号池可插拔（OpenRouter），调用方零改造。
- **嵌入模型与维度为显式契约**：`Qwen/Qwen3-Embedding-8B` 以
  `dimensions=1024` 截断下发。响应向量维度与契约不符时，词元 SHALL 拒绝该
  响应（不向调用方返回长度错误的向量），使「维度漂移」以可观察的失败暴露而非
  静默写坏消费方向量库。
- **上游 provider 钉扎由词元侧账号级注入**（用户 2026-10-18 定）：OpenRouter
  同一 slug 挂多个 provider 且向量空间不同，实测不钉扎时同文本连调 10 次
  min_cos=0.996511（漂移），钉 `Nebius` 后 0.999925（过门）。故 provider
  钉扎是契约必要条件，词元 SHALL 在账号级固化并注入下发，调用方自带的
  `provider` 字段 SHALL 被覆盖。**这需要一小段「只增」代码与一次出片。**
- **嵌入价目 SHALL 显式配置**：价格表默认无嵌入条目，分组/渠道 SHALL 配置
  token 价，否则请求会以「无价可循」失败（fail-closed）。
- **范围收窄（2026-10-18）**：**本 change 只覆盖文本引擎（`fd-text-core`）一条线。**
  法条检索线（`fd-legal-search-mcp` / Qdrant `law_chunks_v2`）经实测判定为
  `Qwen3-Embedding-0.6B` 所建，且硅基流动 key 已恢复可用，用户决策**维持 0.6B、
  不改上游、不重嵌库**——该线退出本 change 范围（详见 design.md Q3/Q4）。

- **BREAKING（对调用方配置）**：`fd-text-core` 的
  `FDTEXT_EMBEDDING_API_BASE` / `_API_KEY` 由 `api.siliconflow.cn` 改为词元网关，
  `FDTEXT_EMBEDDING_PROVIDER_ONLY` 置空（钉扎由词元侧负责）。
  模型名本就是 8B、维度本就是 1024，故库内既有向量**继续可用、零重嵌**。

## Capabilities

### New Capabilities

- `ciyuan-embedding-lane`: 词元的嵌入能力对外契约——入口形状、模型与维度
  契约、上游池与轮转、计费与钉扎口径、上游故障的错误面。

### Modified Capabilities

- `ciyuan-gateway-lanes`: 车道能力清单从「audio / rerank / websearch」三类
  扩展为含嵌入（embedding 走 OpenAI 兼容 `/v1/embeddings`，与 chat 入口同源
  而非第四车道适配器）。既有车道的需求与 Scenario 不变，仅 Purpose 与能力
  枚举表述扩展。

## Impact

- **代码**：一小段「只增」改动——`service/openai_embeddings.go` 的
  `ForwardEmbeddings` 在构造 `upstreamBody` 时按账号级配置注入/覆盖
  `provider` 字段（对应 spec「上游 provider 钉扎由词元侧账号级收口」）。
  需走 fork 补丁级 + 出片 + 滚产。其余全部经词元既有 admin 面完成。
- **部署**：`fd-text-core-env` 一个 Secret 更新（cheap 集群 fd-prod，非 GitOps
  管理，需 kubectl 改）；`fd-text-core` Deployment 滚动一次；词元一次补丁级滚产。
- **数据**：文本引擎库内 2254 块向量零重嵌（模型与维度均不变）；锚点余弦门
  （≥0.999）需复验。**法条线数据零改动**（`law_chunks_v2` 364,801 点不动）。
- **运维**：文本引擎侧硅基流动 key 从 `fd-text-core-env` 退役；词元用现成
  key 55（组 8）作内部服务密钥。**法条侧的硅基流动 key 保留不动。**
- **风险（一个未解阻塞，见 design.md R6）**：网关→OpenRouter 出站请求全部
  EOF 502（同 pod 内 wget 直连同 key 同 URL 为 200），未定位根因。该阻塞
  解除前不得执行消费方切换。另需注意硅基流动账户余额存在波动
  （2026-10-18 曾全模型 402、当日恢复），回滚路径依赖其可用性。
