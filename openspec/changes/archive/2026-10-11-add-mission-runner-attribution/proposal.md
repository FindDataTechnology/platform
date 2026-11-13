# add-mission-runner-attribution

## Why

M2 ③「夜间车道」的事实调研结论改写了切片：sub2api 无原生时间窗路由（车道=组→账号映射+组级 rate_multiplier，均为运维配置），lane 切换经既有 agent-service-config 模型面即可完成——**无需平台代码**；真正的代码缺口是①**runner 回合事件无归属戳**（turn_started/turn_ended 只有 turn_kind/duration——mission 的 runner 侧成本无法对账，M2 出口的「成本对账」只完成了 facade 半边）②**planner v1 三处纪律缺陷**（生产 e2e 实录：窗口检查只在开新步时触发、report 前末步不标 done、长会话上下文膨胀打转）。

## What Changes

- **runner 归属戳**：turn_started/turn_ended payload 增 `session`（回合会话名）与 turn_ended 的 `tokens`（usage 可得时）——mission 派发回合由此可归属（`srv-mission-<id>`），全链成本对账的 runner 半边就位。纯增量载荷，既有消费方零影响。
- **planner pack v2**：三处纪律修正——①窗口检查提到每次醒来 GET 后必核（不再只在开新步时）②report 前所有步骤标终态③醒来先做三行状态小结再动手+单步调查深度上限（防上下文膨胀打转）。
- **车道切换运维配方**（文档非代码）：夜间降费=经 agent-service-config PUT 模型面按档切换 planner 部署模型（车道=sub2api 组映射），写进 change 设计与 planner 文档。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-runner`: 回合事件携带 session 与 token 归属（ADDED requirement）。

## Impact

- 代码：`agent-runner/manager.js`（事件载荷两处）、`scripts/mission-planner-pack.mjs`（v2 技能正文）、`scripts/test-mission-planner-pack.mjs`（断言补）。
- 上线：platform 镜像（runner 同镜像）滚 runner 容器 + planner v2 发布部署。
- 不做：sub2api 时间窗路由（不存在此能力，运维配置替代）；console 侧 runner 回合渲染（归属数据落库即可查，渲染留后续）。

## Non-goals

- 不改计量/结算路径（meter.jsonl 与 sub2api 结算不动——事件载荷是观测面增量）。
- 不做 per-mission 模型切换（mission.model 仍为记录性；执行模型=部署配置）。
