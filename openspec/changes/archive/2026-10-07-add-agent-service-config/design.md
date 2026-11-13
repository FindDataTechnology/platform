# add-agent-service-config — Design

## Context

现状通路（见 proposal 之 Why）：部署动作把 effective rhythm/budget 写进 registry agent entry 的 `metadata`，runner 60s 轮询消费；console 的 pause 直写同一 entry（`setPaused` 先例）；模型是 runner 级单值（`AGENT_RUNNER_LLM`，D8，ADR-0019 已翻案）。约束：registry 是 facet 组件（ADR-0015）；runner 随平台镜像发布、状态外置持久卷（ADR-0018，`LLM_PROVIDERS_STORE` 路由真件在卷上）；三部署清单（platform/facet/wanxing）需同滚。

## Goals / Non-Goals

**Goals:**
- 部署后可重写四维配置（节奏/预算/卡片展示/模型），Overlay 语义跨升级存续
- 写时车道校验，杜绝"上线即 404"
- 生效只走两条既有通道（descriptor 轮询 / 升级排水），不新增传播机制

**Non-Goals:**
- 调用者偏好（姊妹 change `add-caller-preferences`）
- 人设文本与 MCP/技能开关（v2，接近重部署）
- 套餐/车道管理本身（sub2api 面的事）
- 配置变更审计入 fleet 事件流（可后补，不阻塞）

## Decisions

**D1 — descriptor 同时记 overrides 与 effective，overrides 是真源。**
只记 effective 无法区分"部署者覆盖"与"跟随旧默认"，升级重解析就丢了依据。故 `metadata` 增 `config_overrides`（稀疏对象，仅记被覆盖维度）+ 既有 effective 字段照写（runner 消费 effective，零解析逻辑；升级动作用 overrides 对新 manifest 重解析后回写 effective）。弃"只存 overrides 让 runner 解析"——把解析散到 runner，三处（部署/升级/console）各自实现易漂移。

**D2 — 车道校验 = 部署键 group 车道 ∩ 作者白名单，在 facet 写入时算。**
lane 集合取 sub2api 管理面该 key 绑定 group 的可用模型（packs.js 已有 sub2api 管理客户端，铸键同源）；作者白名单是 manifest `serving.modelWhitelist`（`lib/pack-manifest.js` 增可选字段，同批增 `serving.model` 声明默认）。校验属准入控制不属运行时保证——写入后 group 改绑属运行时故障，走既有瞬时/永久错误分类可见。弃"运行时探测"——探测通过到运行之间照样能漂移，且慢。

**D3 — runner 逐 child 取模：`effective_model ?? AGENT_RUNNER_LLM`，经 `LLM_PROVIDERS_STORE` 路由。**
manager 轮询 diff：`effective_model` 变化 → 走升级同款排水重生（复用 drain/respawn 代码路径，不新写）；未设模型回落 runner 默认（旧部署零感知）。计费/预算照旧逐 child。

**D4 — 配置写 API 挂 facet 部署面，console 仿 pauseAction 透写。**
facet 侧新增 registry agent entry 的配置读写路由（`setPaused` 的同族扩展，lib/agent-serving.js）；萬星 console（fd-wanxing 为准，paas `gateway/wanxing` 镜像同步）加 `GET/PUT /api/wanxing/v1/console/deployments/:slug/config` 透写该路由。门禁 = 既有 console gate + 部署者身份比对（`pack_deployments.deployed_by`）或管理员组。facade store 不动（边界已入 spec）。

**D5 — UI：console 的 agent 详情区，谦面只放跳转。**
wanxing-web ConsoleView 部署行展开详情区：生效值 + 来源徽记（已覆盖/跟随声明）+ 行内编辑器（节奏条目、预算数字、模型下拉——选项即 D2 校验通过集）。谦面 pack 详情部署区加"去配置"深链。v1 卡片展示可编辑字段限 name + description（tags 随包）。

## Risks / Trade-offs

- [写时校验与运行时车道漂移] → 接受：校验是准入不是保证；漂移后表现为既有永久错误，板面可见，部署者再配置即愈。
- [升级重解析丢覆盖] → overrides 为真源、effective 幂等重算；单测锁定"覆盖跨升级保留"。
- [两套 console 镜像漂移] → fd-wanxing 先行实现，paas 镜像同 PR 内同步（facet-cutover 拓扑既有惯例）。
- [5min 生效窗引发"没生效"错觉] → UI 沿用部署成功提示的 `effectiveWithinSecs` 文案模式。
- [旧 runner 遇 `effective_model`] → 忽略未知 metadata 字段，回落 env 默认——模型配置在旧 runner 上静默不生效但不断服，回滚安全。

## Migration Plan

上线序：manifest 校验字段（向后兼容，旧 manifest 无新字段照过）→ facet 配置路由 → runner 逐 child 模型 → console API + UI；三部署清单同滚（ADR-0018 惯例）。回滚 = revert sha：`config_overrides` 留在 metadata 中无害，旧 runner 只读 effective 字段照跑。
