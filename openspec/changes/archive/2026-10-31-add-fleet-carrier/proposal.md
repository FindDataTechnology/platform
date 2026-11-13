## Why

底稿 `docs/agent-parallel-execution-explore.md` 切片⑤：用户的设想是「用户的 agents 决定怎么处理」——
平台不做固定拓扑的调度器，只给独立执行单元 + 派活工具 + 准入预算。①-④ 落地后证据链全通
（carrier 列×cost 列×queue_wait/spin_up），「哪个身体跑最划算」第一次可量化——承载（carrier）
现在可以做成**可配置维度**：每个岗位跑在 cell、worker 槽还是 runner，由配置决定、由 fail-open
兜底、由准入硬闸封顶。

## What Changes

- **carrier 正交维度**：`"cell" | "worker" | "runner" | "auto"`，配置三层由细到粗——
  `member.carrier` → `orchestration.constraints.carrier` → 部署默认 `CELL_CARRIER_DEFAULT` →
  `"auto"`；解析顺序 member→fleet→部署→auto。
- **配置面**：`fleet_members` 加 `carrier` 列（additive ALTER）；成员写面接受 carrier；编排写面
  校验 `constraints.carrier` 值域；`materializedSpec` 带上 carrier、`specDrift` 支持**只改承载
  不动 task id/会话**的原位改写（换身体不换会话——切片①的会话级 persona 是前提，已在产）。
- **执行路由**：`runCronJobTurn` 的 persona 分支按解析 carrier 选执行器——`runner` 且目录含该员
  的 a2a entry → 远端执行器（`a2aExecutor`，job 改写为远端形状）；`cell`/其余 → 主链。**fail-open
  降级**：声明 runner 无 a2a entry / 声明 worker 而 worker 池未激活 → 落主链 + 可见 warn +
  回合 detail 留痕（`carrierFallback`）；**永不因配置拒绝一次回合**。
- **worker 认领门**：worker 池 dispatcher 按 task carrier 认领——`cell`/`runner` 不认领（主链/
  远端），`worker`/`auto` 照旧认领；准入硬闸 `FLEET_MAX_INFLIGHT`（默认 4）：同一舰队的在途
  worker 回合达上限时不再认领该舰队的任务（排队不失败，照搬上游 subagent 槽位池纪律）。
- **auto 判据 v1**（只做前二）：目录含该员 a2a entry（runner 部署健康由 registry 保证）→
  runner；cell worker 池有空位 → worker；其余主链排队。成员回合计量列照实记**实际**载体
  （配置与实际的不一致在台账可见）。

## Capabilities

### New Capabilities

- `agent-fleet-carrier`：舰队岗位的承载配置面——三层解析顺序、auto 判据、fail-open 降级、
  换身体不换会话的原位 drift、每舰队在途准入硬闸；配置永不拒绝回合。

### Modified Capabilities

（无——`agent-fleet-core` 的岗位模型/回合缝语义不变（执行器选择的实现细节）；`scheduling-cluster-aware`
的集群成员 v1 仍主链串行，不在本片范围。）

## Impact

- **代码**：`server/routes/fleets-db.js`（carrier 列 + 写面）；`server/routes/fleets.js`（成员写面
  收 carrier + memberView）；`server/fleet-orchestration.js`（constraints.carrier 校验）；
  `server/fleet-reconcile.js`（materializedSpec/specDrift）；`task-engine.js`（task.carrier 持久
  白名单）；`server/worker-slots.js`（认领门 + 准入闸）；`server/cron-runner.js`（runner 路由 +
  fail-open）。
- **契约**：无 carrier 配置的任务行为逐字节等价（解析结果 auto→现状路径）；`executionCarrier`
  瞬态计量标记（切片②）语义不变。
- **测试**：三层解析、fail-open 两源、认领门、准入闸、drift 原位改写；既有 fleet/park 面零回归。
- **风险**：runner 路由的远端回合缺 runPersona 的身份注入（identity/prompt segment 是 persona
  执行器的）——远端回合按 a2a 既有契约执行（提示词里不带舰队身份段，首轮可接受；挂账 v1.1）；
  集群扇出成员不参与 carrier 路由（v1 主链串行）。
