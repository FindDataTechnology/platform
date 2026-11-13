# Proposal: add-config-roster-gate

## Why

昨片 add-deploy-roster-gate 关了部署门，但 console 对**在役部署**的 model 配置写仍只过车道门（同缺口类别——车道过+花名册无的模型写上活代理，复刻「静默空返照计费」）。且生产审计抓到**现患**：wx-alpha 在役挂 `inclusionai/ling-3.1-flash`（不在 8 项花名册）——它的每个回合都在 UNKNOWN_MODEL 静默空返、照计费。昨片 spec 需求文已写「(and config-write)」，本片把承诺做成真的并清现患。

## What Changes

- **配置面 roster 门**：configWriteCore 的 GET-merge-PUT 里，entry 读取已在流程中——`metadata.runner_id ?? fleet 默认行` → board 花名册 → `modelChoiceError` 加 roster 层；非 null 的 model 写在 PUT 前被拦（400 `MODEL_NOT_IN_ROSTER`）。降级开放三态同部署门（调度器未武装/板不可达/心跳无字段/entry 无 runner 归属且 fleet 表空）。显式 null（清回声明默认）不受门影响。
- **wx-alpha 现患清零**：经配置面把其 model 覆盖清 null（回落 runner 默认 deepseek-v4.1-flash，在册）——用产品路径自身完成，兼作正路径生产实证。
- 零 schema 变化（runner 归属读 registry entry 现场值，不落 pack_deployments 缓存——entry 即唯一事实源）。

## 生产连带（实施中发现，同批根治）

配置写 GET-merge-PUT 存在独立真缺陷：registry GET 返回公网显示 URL，回写（PUT 422→register 兜底）把它存成自环代理目标——生产 4 条目 A2A 因此断路（含本片验证写触发的 2 条）。同批修复：PUT 前按宿主 fleet 几何重建 origin+provider/version 归一；数据侧 4 条目已 PUT 回正确 origin。

## Capability

`a2a-agent-serving`（MODIFY「A deploy-time model choice must resolve on the hosting runner's roster」——补配置面场景，需求文其余不动）。

## Impact

- 代码：gateway/packs.js configWriteCore 一段（~15 行）；无新依赖无新端点。
- 部署：platform 镜像出片（law-ai 线）→ facet 面滚（配置路由只在 facet 服役；其余五面共镜像可随后续自然滚，无行为依赖）。
- 生产影响面：console 配置写从「车道门」变「车道+花名册双门」；wx-alpha 回合从静默空返计费变正常应答。
