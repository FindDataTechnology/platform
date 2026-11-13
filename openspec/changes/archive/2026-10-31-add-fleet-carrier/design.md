# Design: add-fleet-carrier

> 底稿切片⑤。前提全在产：切片①会话级 persona（换身体不换会话的技术前提）、切片② executionCarrier
> 瞬态计量标记、切片④ 锚行带 carrier。runner 形态=目录 a2a entry（registry 部署）——runA2aRemoteTurn
> 已是现成远端执行器。

## Context

- 三层解析的读点在定时缝（runCronJobTurn）与 worker 认领门（worker-slots dispatcher）——两处都要
  「这个任务该在哪跑」。任务上带物化来的 `carrier`（config），实际载体另有 `executionCarrier`
  （切片②瞬态标记，认领/执行器写）——**配置与实际分列，台账可见不一致**。
- member.carrier 进 fleet_members 列 + 写面；编排 constraints.carrier 进 fleet-orchestration 校验。

## Goals / Non-Goals

- Goal：三层解析、runner 路由、fail-open、认领门、每舰队准入闸、drift 原位。
- Non-Goal：集群扇出成员的 carrier（v1 主链串行）；远端回合的舰队身份注入（v1.1）；端口按 pod、
  HarnessAdapter 抽象（多 harness 线的事）；runner 部署的编排（registry 面已有）。

## Decisions

### D1 解析函数单点

`resolveTaskCarrier(job)`（cron-runner 导出，测试可注）：member.carrier → fleet.constraints.carrier
→ `CELL_CARRIER_DEFAULT` → "auto"。db 读两小点（getMember/getFleet），sqlite 本地微秒级，不缓存。

### D2 runner 路由 = 目录 a2a entry 匹配

成员的 targetId 就是 catalog agent id；runner 部署的 agent 在目录呈 a2a entry。路由：entry =
listAgents().find(a => a.mode === "a2a" && rosterPresetId(a.id) === job.preset)；命中 → a2aExecutor
+ job 改写 `{preset: entry.id, targetType: "a2a"}`（远端会话 id 仍用本回合的镜像/子会话 id——
a2a executor 的 contextId=sessionId 语义不变）；不命中 → fail-open 主链 + detail.carrierFallback=
"runner-no-entry"。

- 备选被否：由 registry 直查部署健康——目录已是 registry 的投影（ADR-0015），二查是重复真源。

### D3 worker 认领门在 dispatcher 内

dispatcher 现签名 `(task) => claimed`——按 `task.carrier ?? "auto"` 分流：cell/runner → return false
（主链/远端）；worker/auto → 既有认领逻辑。`auto` 的行为 = 现状（池激活才注册 dispatcher）——
无配置零变化。

### D4 准入闸在 scheduleNext 的检出循环

`FLEET_MAX_INFLIGHT`（默认 4）：检出循环内统计 busy worker 中 `currentFleet === task.sourceTag.fleetId`
的数量，达上限 → 该任务本轮跳过（留在 waiting，FIFO 语义由 findIndex 的检出顺序保证）。worker
增加 `currentFleet`（runOnWorker 时记）。远端回合不计数（runner 侧预算管辖，spec 明示）。

### D5 specDrift 的承载位

`task.carrier ?? null` vs `spec.carrier ?? null` → changes.carrier；addJob/updateJob 透传。物化
spec 从 member.carrier 取（reconcile 时已读成员行）。

## Risks / Trade-offs

- [ runner 远端回合无舰队身份段 ] → a2a 既有契约（提示词即全部）；v1.1 随身份注入面补。
- [ member.carrier 与 task.carrier 漂移窗口（改成员后 reconcile 前）] → drift 检测在 reconcile
  周期内收敛；窗口内按任务上的旧承载跑——与 cadence 漂移同形，可接受。
- [ 准入闸按 sourceTag.fleetId，非舰队任务不计数 ] → 非舰队 worker 任务无舰队预算语义，独立
  走池 FIFO；spec 明示本闸是舰队维度。

## Migration Plan

1. 滚版即生效；无 carrier 配置的任务 auto→现状路径（逐字节等价）。
2. 验证：真机一次 cell→worker 的承载改写（reconcile 原位、task id 不变）+ fail-open 一发。
3. 回滚：镜像回滚即回退（carrier 列留存无害）。

## Open Questions

- 无阻塞项。auto 的「cell 无在途回合」判据（底稿 D1a 第三条）v1 不做——主链本就串行排队，
  判据无增量信息。
