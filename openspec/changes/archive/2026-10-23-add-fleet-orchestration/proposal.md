# Proposal: add-fleet-orchestration

## Why

编导代数第一波(explore 底稿 §五/Q9 决议):turnRequest 契约(`add-turn-contract`)已立,delegation 车道与 O1 事件收口已就位并经生产实证——现在把「边」立起来:舰队以显式声明描述**谁触发谁、结果去哪**,supervisor(主管派活)与 pipeline(流水线)两种范式随边落地,mode 预制图降级为语法糖。这是 50+ 混合舰队的激活经济学前提(被动岗零空闲成本),也是柏讯流水线的机制底座。

## What Changes

- **`fleet.orchestration` 声明段**:边集 `edges` + 约束 `constraints`(spanMax / budgetPerEdgeMin / maxChainDepth)。四种边:`trigger`(= 既有 cadence 的图形态,行为不变)、`report`(= 既有报数上行,行为不变)、`dispatch`(主管派活)、`handoff`(上游完成接棒下游)。写面全量校验:边只引用本舰岗位、handoff 子图**无环**(有界环随第二波 fanout)、链深 ≤ 声明链长、显式声明不隐式推断。
- **dispatch 边(O3)**:成员回合(fleet-mcp)新增 `dispatch_post` 工具——按岗位 ref 派活给同舰岗位,走既有 delegation 车道(manual 任务 + `origin.fleet` 证据 + initiator=派发岗会话),**异步送达**(结果经聚合器下回合注入派发岗);约束:仅同舰队、不得自派、派生回合 depth=1 不可再派发、每岗每回合 ≤3 次 + 舰队每小时 ≤30 次(env 可配);双方回合经 O1 收口自动产事件(零新增记录路径)。
- **handoff 边**:O1 收口挂点(runCronJobTurn wrapper)在回合结束后检查该岗出边——有 handoff 即为下游岗创建 manual 任务(证据 `origin.fleet`、深度=链位+1、每跳时长上限继承 `budgetPerEdgeMin`),整链逐跳产 O1 事件、预算合计记发起回合。
- **mode 预制图语法糖**:`schedule`(默认,无 dispatch/handoff 边 = 现状逐字节不变)/`supervisor`(全舰 dispatch 许可 + 默认手动触发)/`pipeline`(声明 handoff 链);mode 展开为边集与用户显式边合并,单一边文法、单一定源。
- **depth 界分道**:`agent-turn-contract` 的全局界 1 修订为**按道分界**——dispatch 道(临时派发)界 1,handoff 道(声明链)界 = 图校验通过的声明链长;`assertTurnRequest` 相应扩展。

## Capabilities

### New Capabilities

- `agent-fleet-orchestration`: 编导代数第一波——orchestration 声明段与边文法(trigger/dispatch/handoff/report)、图校验(无环/链深/显式)、dispatch_post 工具与舰队级频次护栏、handoff 完成触发、mode 预制图语法糖;执行真源仍是任务引擎+delegation 车道,不引入第二调度器。

### Modified Capabilities

- `agent-turn-contract`: MODIFIED——深度上限从固定 1 改为按道分界(dispatch 界 1 / 声明链界),防链式放大的语义保留、边界来源改为声明约束。

## Impact

- **代码**:`server/routes/fleets.js`(orchestration 段写面+校验)、新 `server/fleet-orchestration.js`(图校验纯函数 + handoff 触发器)、`server/fleet-mcp.js`(dispatch_post 工具)、`server/fleet-events.js`/`server/turn-request.js`(深度分道)、`server/cron-runner.js`(收口挂 handoff 检查)、`server/routes/delegation.js` 或桥内(origin.fleet 透传既有,无需新路径)、驾驶舱 orchestration 只读面(轻)。架构师 pack 的 draft 校验后续 change 吸收边语法(v1 架构师仍只编结构,不编边——如实记)。
- **测试**:新 `scripts/test-fleet-orchestration.mjs`(图校验矩阵/dispatch 护栏全拒绝面/handoff 链触发与预算记账/mode 展开);既有十套回归零新增红(schedule 模式逐字节等价是回归门)。
- **兼容性**:未声明 orchestration 段 = schedule = 现状逐字节;报数/拍板/节奏/模型归位/事件面全部不动;出片随下一列车。
- **非目标**:fanout/有界环/裁决聚合与 event 边(第二波);T1 skill 岗(独立 change);黑板(O5);自动重试;架构师 NL 编边(v2);跨舰队派发。
