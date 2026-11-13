# fix-fleet-model-drift — 设计

## Context

「独木桥三个人」问题：session.jsonl 持久化、cell boot agents.create、会话内部 compaction/goal 都可能写 child 的当前选择，而我们自己的账本（ctx.session.model）则手拨过去。诊断细节见 proposal.md — Why。核心架构事实：child 端没有查询当前选择的 RPC — 观察上锁，写也只靠 create/spawn。

## Goals / Non-Goals

**Goals:**
- G1 显式链岗位任何回合不再困在中毒态（自愈 +
 preemptive force assert 二选一，代价可控）。
- G2 漂移事件有可读脚注（detail.modelMismatch），运维不需重跑侦察。
- G3 无显式链岗位不变的性能路径。

**Non-Goals:**
- 不查毒器身份（dsh 内部 compaction / 外源 stroke 都可能），只是使其无法影响回合执行。
- 不改 bots / 会话 UI / jsonrpc 协议。

## Decisions

### D1 强制断言只落显式链，且复用既有 initialize 通道

**D1**：normalizeModelForJob(plan.explicitChain=true) 时，不再调用 `switchModelTo(hop)`（依赖账本早退），而调用新增的 `assertModel(hop, { force: true })`（force 绕过 `if ctx.session.model.id===hop` 早退；走 live setModel 若有 RPC，否则重启/改 restart 缺陷）。**spawn 一次 ~25ms 量级**（单 pod cell 实测 boot 500ms，非热 path；小时巡逻岗位开得起）—— traded off 不写 agent-side；曝防闲 spawn 也仅每阵一次，不会增长。

**D2 自愈兜底**：后置失败归路里追加：若回合 error/tdo 判定螷为模型不可用（`model_not_available`/`INVALID_MODEL`/`cannot find model`）且本轮没用 force，追加一次强制断言 + 重走；recovered→detail.modelRectified=true。**recover 一次即停**——不再重试（走向 existing 行驶走向失败的 fail-fast 语义）。

### D2 modelMismatch 观测列记在何处 — 请求 header 而不是引擎记账

`trace_turn_id` 的 `request/header.config.model` 是**孩子真正发出的模型**。cron-runner 收成回合后 (traceMapFor 已 trace_turn_id 检索 header)，若 `header.model !== landedModel` → detail.modelMismatch={declared: plan.candidates[0], resolved: landed, observedHeader: header.model}。入洞计时：**多长**（最近真实阵）同 memberView latestTurnUsage 同列同行载入。

### D3 回滚门

`FLEET_MODEL_ASSERT_SOFT=1`：回旧行为（trust accounts + 允许一次非 force 重试）。默认关闭（旅途 exhausts new behavior）。原因：introduce 在台账里施命以后判断哪个是回归——出错后能快速回喂。

## Risks / Trade-offs

- **spawn 抖动**（restart 25ml 下每次对会话持久化覆盖）→ 有 trace_turn_id=相同 turn id 入 trace.db 对撞不可避免；dsh session-persistence 稳存,displayId 也稳定，不炸 rebuild。
- **踩线重试语义重复**：our own existing retry-on-upstream-fast-fail 与自丽兜応重连可能成基调停他——中 determinate one（model_not_available）首次仅重断言一次。
- **force assert 于直播（live setModel）与 initialize 不一致**——force initialize 会真的 spawn；联网鉴池要走 spawn；不写 force+live joint。

## Migration Plan

- 常规 snapshot → image → relay → ccr → 滚产。
- 回滚=回滚镜像 + 加 `FLEET_MODEL_ASSERT_SOFT=1`。
- 波次：先「modelMismatch 观测列 + force assert」同班（相辅相成）；放第二班「自愈重走」（若依旧上证毒性重新)。
同一班发，同但准要红旗 listed 到户。

## Open Questions

- poisoner 是谁不查；如果调研后，可以釉部查各 compaction/goal 车道的 setModel 后检锂。今天不函。
