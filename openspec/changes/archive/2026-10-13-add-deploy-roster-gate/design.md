# Design: add-deploy-roster-gate

## Context

- 车道门现状（gateway/packs.js:1274-1295 部署面 / 1934-1954 配置面）：`modelChoiceError({model, whitelist, lanes})`（lib/agent-serving.js:309）——白名单∩键车道。F3.3 实证第三层缺失：车道过、花名册无 → child UNKNOWN_MODEL 静默空返、照计费（计费侧修复管不到空返——它不产生 JSON-RPC error）。
- 花名册权威源：`buildLlmProfile()`（dsh-profile.js:178）= volces 环境路由（runner 无 LLM_API_KEY 则缺省）∪ 用户 providers（llm-providers.js `buildUserProviderEntries()`，读 LLM_PROVIDERS_STORE 文件）——与 child settings.yaml 的写入同源，格式零漂移。
- 心跳链：fleet.js `createFleetSampler.sample()` 每 30s 发 `runner_stats`；observer 面板 `...(e.payload ?? {})` 原样展开 → 加字段即上面板，observer/前端零改动。
- 部署路由已有 boardNow（≤10s 缓存）与安置解析（runnerPlacement，含 fleetRows[0] 默认退化路径）；调度器武装=FLEET_SCHEDULER_ENABLED=1。

## Goals / Non-Goals

**Goals**：三层门补 roster 层（部署面）；心跳携带花名册；降级开放三态（未武装/板不可达/心跳无字段）不拦部署。

**Non-Goals**：配置面（agent-service-config 的 model 写）不加门——pack_deployments 表无 runner_id，解析宿主需 registry 往返，记已知缺口；描述符遗留 effective_model（未被请求触碰）不验（与车道门同口径）；不动 observer/fleet-observability spec（「携带」语义非穷举）；不做 roster 变更触发存量审计。

## Decisions

1. **roster 源=buildLlmProfile 而非手拼**：与 child profile 写入同函数，格式漂移即修复漂移（一处定义）。sampler 每刷新一次（异步、失败省略字段——空数组=拒绝一切，宁缺勿假）。
2. **sample() 保持同步**（既有测试同步调用）：sampler 持 roster 缓存，tick 时后台刷新（`Promise.resolve(provider()).then(...)`），首 tick 后生效；provider 可注入同步数组供测试确定性断言。
3. **部署门在车道门后串行**（同一 requestedModels 循环外另起一段）：安置 runner = `runnerPlacement.runnerId ?? fleetRows[0].id`（未打标默认路径）；`board.runners[id].models` 非数组 → 跳过。错误码 `MODEL_NOT_IN_ROSTER`（与 MODEL_LANE_REJECTED 并列，前端可分辨指引）。
4. **helper 加参不复制**：`modelChoiceError({model, whitelist, lanes, roster})`——roster=null 未知（开放）语义与 lanes=null 对齐；一处定义两执法点（部署面现用；配置面将来接入即得）。

## Risks / Trade-offs

- **降级开放=门可被观测面故障绕过**：与调度器健康盲纪律一致（观测缺失不拦部署）；攻击面可忽略（门是防呆不是防恶）。
- **心跳字段滞后 30s**：runner 改 providers store 后最迟一 tick 内面板更新；部署门读 boardNow ≤10s 缓存——总滞后 <40s，远快于任何人工部署节奏。
- **旧 runner 镜像无字段 → 全 fleet 降级开放**：滚动顺序无关紧要（门读面板，新 runner 上线即携带）；四面共享镜像，同滚即齐。
- **空数组语义**：provider 失败省略字段（开放）vs 真空 roster 空数组（拒绝一切）——严格区分，防止「读取失败」被误当「无模型」。

## Migration Plan

纯增量：镜像滚后心跳自动带 models（≤30s），部署门自动从降级开放转生效——无切换时序、无数据迁移、无回滚步骤（回滚=旧镜像即回降级开放）。
