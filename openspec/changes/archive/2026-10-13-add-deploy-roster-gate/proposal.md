# Proposal: add-deploy-roster-gate

## Why

F3.3 挂账①：部署侧车道门只验「部署键的 sub2api 车道」——`inclusionai/ling-3.1-flash` 过了车道门但不在 runner 的 dsh 模型花名册 → child `pi-ai provider has no configured model`（UNKNOWN_MODEL）**静默空返**，回合照跑照计费（outcome:ok）。错回合计费侧已修（fd-wanxing fix-error-turn-billing），但**空返回合不产生 JSON-RPC error，计费修复管不到它**——根治 = 部署时就把不在承载 runner 花名册里的模型拒掉。

## What Changes

三层门补齐第三层（whitelist → lanes → **roster**）：

- **runner 心跳携带花名册**：fleet sampler 的 runner_stats 负载加 `models`（权威源=compose 子 profile 的同一 `buildLlmProfile()`——volces 路由∪用户 providers 的 model id 并集；sample() 保持同步，roster 走缓存+后台刷新）。observer 面板对心跳负载原样展开（`...(e.payload)`），`models` 自动上 `runners.<id>`，observer 零改动。
- **部署门**：deploy 路由在车道验证后，对安置 runner（placement.runnerId ?? fleet 默认行）的 `models` 再验一次；不在册 → 400 `MODEL_NOT_IN_ROSTER`（附在册清单）。**降级开放**三态沿用调度器健康盲纪律：调度器未武装/board 不可达/runner 心跳未携带 models（旧镜像）→ 跳过不拦。
- `modelChoiceError` 加 `roster` 参数（lib/agent-serving.js 单点，部署路由复用）。

范围裁剪：配置面（agent-service-config 的 model 写）不加 roster 门——pack_deployments 表不记 runner_id，解析宿主需额外 registry 往返，记已知缺口（挂账清单更新）；描述符遗留的 effective_model（未被本次请求触碰）不验，与车道门同口径。

## Capability

- `a2a-agent-serving`（MODIFY 部署要求：模型选择三层验证）
- `agent-runner`（ADD：心跳携带模型花名册）

## Impact

- 代码：paas 三处小改（lib/agent-serving.js helper+runner fleet.js sampler+gateway/packs.js 部署路由）。
- 镜像：platform 镜像滚（facet/platform + runner-serving/b/c 四面共享同镜像）。
- 生产影响面：部署时选错模型的调用方从「部署成功→空返计费」变「部署即拒+在册清单指引」；存量部署零影响；board 心跳多一字段。
