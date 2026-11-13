# Proposal: add-turn-contract

## Why

一次回合的契约今天散落在三处隐式形态里:`runJobNow` 的 job 记录、拍板 execute-now 的 manual 任务、delegation 唤醒——O1(`add-fleet-turn-events`)已在回合收口用一条 ad-hoc 归属链(`sourceTag ?? origin.fleet ?? persona 扫描`)把它们读出来,但那是事件面的推导,不是契约本身。编导代数(explore 底稿 O2/Phase 3)的每条边点火都要发出一个**显式**的 turnRequest;派发(O3)与模式(O4)都挂在这个原语上。本 change 把它立为一等公民:纯派生函数 + 受界取值 + 等价 harness,**行为零变化**。

## What Changes

- **`server/turn-request.js` 新模块(纯函数)**:`buildTurnRequest(job)` 从任务引擎记录派生显式契约——`{ source, targetRef: {kind, id}, brief, evidence: {sourceTag?, origin?, initiator?}, resultSink, depth, budget }`。既有全部触发路径均可表达:cron 节奏(source=cron, resultSink=report)、拍板 execute-now(source=manual)、delegation 唤醒(source=delegation, resultSink=caller——聚合回投既有事实)、集群扇出成员(多次 source=cron 并行)、a2a 外发(depth=1,既有 X-Delegation-Depth 事实)、非舰队任务(无归属,照常表达)。
- **取值受界**:`source` 现行 cron|manual|delegation,**peer|event 保留**(O3/O4),当前构造 SHALL 结构化拒绝;`resultSink` 现行 report|caller(blackboard 保留给 O5);`depth` 现行 0/1,界 1,超界结构化拒绝(为 O3 派发递增预置闸门)。
- **单一定源**:`fleet-events.js` 的 source/归属推导改为消费 `buildTurnRequest`(O1 事件三源判定与 turnRequest.source 同源;`turnSourceFor` 退役为内部别名)。O1 事件字段与行为不变。
- **等价 harness**:新套件钉住各路径的派生形状与拒绝面;既有八套舰队测试(含 turn-events/architect)全绿即行为等价的证明——不引入任何新执行路径、不动 preset 归位/模型归位/身份注入/报数通道。

## Capabilities

### New Capabilities

- `agent-turn-contract`: 一次回合的显式契约——buildTurnRequest 纯派生覆盖全部既有触发路径、取值受界(保留位结构化拒绝)、深度界 1、回合执行路径消费后行为等价。

### Modified Capabilities

(无——纯新增能力面;O1 的 agent-fleet-core delta 文本不受影响,实现侧改为同源派生属行为等价重构)

## Impact

- **代码**:新 `server/turn-request.js`;`server/fleet-events.js` 消费它(对外签名与事件形状不变);`server/cron-runner.js` 零改动(O1 收口已就位,派生在事件记录内完成)。
- **测试**:新增 `scripts/test-turn-request.mjs`(派生矩阵 + 保留源拒绝 + 深度界);八套既有舰队套件全绿为等价证明。
- **兼容性**:零行为变化、零 API 变化、零存储变化;不改任务引擎调度语义。
- **非目标**:不实现 peer/event 构造与派发(O3)、不做 mode/代数(O4)、不加 skill 目标类型(T1,Phase 3)、不做黑板(O5)。
