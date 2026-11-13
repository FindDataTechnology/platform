## Purpose

舰队岗位的承载配置面：每个岗位跑在哪种身体上（cell 主链 / cell worker 槽 / runner 远端）成为
可配置维度——用户（或其 agents）决定拓扑，平台提供解析、fail-open 兜底与准入封顶；配置永不
拒绝一次回合。

## ADDED Requirements

### Requirement: 承载三层配置与解析顺序

岗位承载 SHALL 是目标类型之外的正交维度，取值 `"cell" | "worker" | "runner" | "auto"`；配置
SHALL 三层由细到粗：成员级 `member.carrier` → 舰队级 `orchestration.constraints.carrier` →
部署默认 `CELL_CARRIER_DEFAULT` → `"auto"`；解析顺序 SHALL 严格 member→fleet→部署→auto，先
命中先生效。成员列与编排约束 SHALL 在写面校验值域（非法值结构化拒绝并提示可选值）；成员的
carrier SHALL 随物化 spec 进任务，承载变更 SHALL 走既有 reconcile 的**原位改写**——task id、
绑定会话、执行历史不变（换身体不换会话）。

#### Scenario: 三层覆盖顺序

- **WHEN** 舰队 constraints.carrier=worker 且某成员 carrier=cell
- **THEN** 该成员解析为 cell（成员级优先），其余成员解析为 worker（舰队级）

#### Scenario: 无配置回落 auto

- **WHEN** 成员与舰队均未声明 carrier 且部署未设默认
- **THEN** 解析为 auto，行为与本次变更前逐字节等价（worker 池激活则认领，否则主链）

#### Scenario: 换身体不换会话

- **WHEN** 一个已有执行历史的岗位成员的 carrier 从 cell 改为 worker 并 reconcile
- **THEN** 任务 id、绑定会话与执行历史保持不变，仅承载位变化；下一回合在新载体上以**同一会话**
  续执行（会话级 persona 驻留保证组合随会话走）

### Requirement: 执行路由与 fail-open 降级

定时车道的 persona 回合 SHALL 按解析 carrier 路由执行器：`runner` 且目录含该岗位的 a2a entry
（runner 部署在 registry 的形态）→ 远端执行器；`cell` → 主链执行器；`worker` → worker 槽认领
（池未激活 → 主链）。降级 SHALL fail-open 且显式：声明 `runner` 但目录无该员 a2a entry、或
声明 `worker` 而 worker 池未激活 → 落主链执行并完成回合，同时留下可观测痕迹（日志 warn 与
回合 detail 的 carrierFallback 标记），MUST NOT 静默、MUST NOT 拒绝回合。回合计量列 SHALL
记录**实际**载体（认领/执行器标记），配置与实际不一致由此可查。

#### Scenario: runner 声明落远端

- **WHEN** 成员 carrier=runner 且目录存在其 a2a entry
- **THEN** 回合走远端执行器，回合计量列 carrier=remote

#### Scenario: runner 声明无部署显式回退

- **WHEN** 成员 carrier=runner 但目录无该员 a2a entry
- **THEN** 回合落主链执行器照常完成，detail 带 carrierFallback=runner-no-entry，日志 warn 在案

#### Scenario: worker 声明而池未激活

- **WHEN** 成员 carrier=worker 且 worker 池未激活（cap=0）
- **THEN** 回合落主链执行器照常完成，detail 带 carrierFallback=worker-pool-inactive

### Requirement: 每舰队在途准入硬闸

worker 池 SHALL 施加每舰队在途上限（`FLEET_MAX_INFLIGHT`，默认 4）：同一舰队的在途 worker 回合
达上限时，该舰队的后续任务 SHALL 停留在等待队列（排队不失败、不抢占、不拒绝），有槽位释放后
按既有 FIFO 继续认领。主链执行天然串行（=上限 1）不受该闸影响；远端回合不计入本闸（远端准入
由 runner 侧预算管辖）。闸值 SHALL 可配且非法值回落默认。

#### Scenario: 达上限排队不失败

- **WHEN** 某舰队在途 worker 回合达到 FLEET_MAX_INFLIGHT，该舰队又一任务被认领队列检出
- **THEN** 该任务停留在等待队列，不失败、不取消；任一在途回合释放后它按 FIFO 获得槽位

#### Scenario: 无配置零变化

- **WHEN** 部署未设置 FLEET_MAX_INFLIGHT 且 carrier 均为 auto
- **THEN** 除每舰队默认上限 4 生效外，认领行为与本次变更前逐字节等价
