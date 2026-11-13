## MODIFIED Requirements

### Requirement: 执行路由与 fail-open 降级

定时车道的 persona 回合 SHALL 按解析 carrier 路由执行器：`runner` 且目录含该岗位的 a2a entry →
远端执行器。**匹配规则 SHALL 是部署 agent 键对岗位 persona 键**：a2a entry 的 registry path 尾段
（`/packs/<packId>/<agentKey>` 的 `<agentKey>`）经 roster 键归一后 SHALL 与任务的 persona preset
一致方为命中——entry 的 catalog id 恒带 `registry-` 投影前缀，MUST NOT 作为匹配依据。`cell` →
主链执行器；`worker` → worker 槽认领（池未激活 → 主链）。降级 SHALL fail-open 且显式：声明
`runner` 但目录无该员 a2a entry、同名 agent 键命中多个 a2a entry（跨包同名，歧义）、或声明
`worker` 而 worker 池未激活 → 落主链执行并完成回合，同时留下可观测痕迹（日志 warn 与回合
detail 的 carrierFallback 标记：`runner-no-entry` / `runner-ambiguous` / `worker-pool-inactive`），
MUST NOT 静默、MUST NOT 拒绝回合、MUST NOT 在歧义时猜测取其一。回合计量列 SHALL 记录**实际**
载体（认领/执行器标记），配置与实际不一致由此可查。

#### Scenario: runner 声明落远端

- **WHEN** 成员 carrier=runner 且目录存在 a2a entry 的部署 agent 键与该成员 persona 键一致
- **THEN** 回合走远端执行器（任务改写为该 entry 的远端形态），回合计量列 carrier=remote

#### Scenario: runner 声明无部署显式回退

- **WHEN** 成员 carrier=runner 但目录无 agent 键匹配的 a2a entry
- **THEN** 回合落主链执行器照常完成，detail 带 carrierFallback=runner-no-entry，日志 warn 在案

#### Scenario: 跨包同名歧义显式回退

- **WHEN** 成员 carrier=runner 且目录中 ≥2 个 a2a entry 的部署 agent 键与该成员 persona 键一致
- **THEN** 回合落主链执行器照常完成，detail 带 carrierFallback=runner-ambiguous（不猜测取其一），
  日志 warn 在案

#### Scenario: worker 声明而池未激活

- **WHEN** 成员 carrier=worker 且 worker 池未激活（cap=0）
- **THEN** 回合落主链执行器照常完成，detail 带 carrierFallback=worker-pool-inactive
