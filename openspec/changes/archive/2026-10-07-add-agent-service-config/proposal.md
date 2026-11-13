# add-agent-service-config

## Why

Agent 服务部署那一刻之后就"冻住"了：运营侧只剩暂停和名单两个开关，部署者要调节奏、调预算、换模型，唯一的通路是重新部署；而配置的灵魂维度"模型"被设计 D8 锁在 runner 级（全 runner 一个 `AGENT_RUNNER_LLM`），部署者根本无从按服务区分成本档与能力档。观测与管控还割裂在两个品牌面——部署在谦面、暂停在萬星。本 change 为 Agent 服务立「服务配置」（Service Config，词条已入 CONTEXT.md；模型逐部署选择的架构决策已立 ADR-0019）。

姊妹 change `add-caller-preferences`（调用者偏好）依赖本 change 落定的中间层，另行立项，不在本范围。

## What Changes

- 新增**服务配置**层：Agent 服务部署实例的可重写运行参数集，挂在部署上、不挂在包版本上——v1 维度：工作节奏（rhythm）、回合预算（turn budget）、AgentCard 展示字段、**模型**
- 配置页落在萬星 console 的 agent 详情页（与板面/暂停/allowlist 同门）；谦面 pack 详情的部署区放"去配置"跳转
- 模型逐部署生效（ADR-0019）：runner 按 descriptor 为各 child 取 LLM，未设置回落 `AGENT_RUNNER_LLM` 默认
- 模型选项合法性写入时校验：以部署键的 sub2api 车道授权为准，作者 serving contract 白名单可选收窄——不让服务带着未授权车道上线后运行时 404
- 生效语义只有两档：descriptor 字段无感生效（runner 60s 轮询，5min 窗）；模型变更经升级同款排水重生通道（排干在途回合 → child 重生）
- 升级存续用 Overlay 差异语义：包升级时未覆盖字段跟随新 manifest 默认，已覆盖字段保留；部署时的 override 成为服务配置的首次写入，不再是"一次性"参数
- 权限：部署者 + 平台管理员（复用部署动作门禁）；作者不能改别人部署出来的服务

## Capabilities

### New Capabilities

- `agent-service-config`: 服务配置层的完整行为——维度与读写面、写时车道校验、两档生效语义、升级 Overlay 存续、权限门禁

### Modified Capabilities

- `a2a-agent-serving`: 「部署动作」requirement 变化——部署时的 rhythm/budget 覆盖不再是随请求丢弃的一次性参数，而是服务配置的首次写入；descriptor 增记 effective model
- `agent-runner`: 「每部署角色一个专属 child」requirement 变化——child 的 LLM 由 descriptor 逐部署推导（回落 runner 默认），模型变更触发排水重生

## Impact

- **存储与写面**：registry agent entry 的 metadata 扩展（经 facet 部署面 API 写入，`gateway/packs.js` + `lib/agent-serving.js`）；facade store 不掺和（保持纯调用者/计量语义）
- **运行时**：`agent-runner/`（config/manager/child）——逐 child LLM 推导、`LLM_PROVIDERS_STORE` 路由真件接受覆盖、模型变更的排水重生；升级通道复用，不新增生效通路
- **console（跨仓）**：paas `gateway/wanxing/console.js` 与 fd-wanxing `services/wanxing-facade/console.js` 镜像加配置读写端点（仿 pauseAction 写通路）；fd-wanxing `wanxing-web` ConsoleView 增 agent 详情/配置页
- **校验**：`lib/pack-manifest.js`（作者白名单声明）与写时车道校验（对 sub2api group 绑定求交）
- **词条与决策**：CONTEXT.md（服务配置）与 ADR-0019 已先行落盘
- 调用者偏好（webhook 回调、收割窗、CLI 入口）不在本 change——见 `add-caller-preferences`
