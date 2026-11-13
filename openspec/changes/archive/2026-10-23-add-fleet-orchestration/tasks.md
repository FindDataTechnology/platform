# Tasks: add-fleet-orchestration

## 1. 声明段与图校验(纯函数)

- [x] 1.1 fleets 表幂等加列 `orchestration`(JSON);fleet 读写透传;写面接受 orchestration 段并调校验;验证:无段舰队读写逐字节不变
- [x] 1.2 新模块 `server/fleet-orchestration.js`:`validateOrchestration` 图校验(边引用/handoff 无环/链深≤maxChainDepth 默认8/span 警告/budget 合法)+ mode 展开(schedule/supervisor/pipeline,读时展开不落库);验证:矩阵单测含环拒/链深拒/隐式不推断
- [x] 1.3 turn-contract 深度分道:`buildTurnRequest` 从 `evidence.origin.fleet.depth` 读深度(缺省 0);`assertTurnRequest(request, {lane})` 按 dispatch 界 1 / handoff 界声明链长分道;验证:三场景(派发道拒 2/声明链放行 3/拒 6)断言

## 2. dispatch 工具与护栏

- [x] 2.1 fleet-mcp 新工具 `dispatch_post` + 回环桥 `/api/fleets/dispatch`:归属解析→同舰/非自派/深度/每岗每回合≤3/舰队每小时≤30(事件流聚合零新存储)五护栏,通过走 `engine.createManualTask`(origin.fleet 深度=1);验证:全拒绝面 + 任务创建形状断言
- [x] 2.2 派发闭环:聚合器回投派发岗会话(下回合注入)复验 + 双方 O1 事件自动产(delegation/ok);验证:注入 executor 断言 prompt 含派发者身份

## 3. handoff 接棒

- [x] 3.1 `runCronJobTurn` 收口挂 handoff 检查:出边→manual 任务(origin.fleet 链位+1/budget),失败如实转述接棒,越界不建任务但记 O1 事件留痕;验证:上游 ok/failed 两态接棒 + 链深守界
- [x] 3.2 orchestration 读面:cockpit/memberView 附 orchestration 只读视图(边集+模式);验证:形状断言

## 4. 测试与回归

- [x] 4.1 新增 `scripts/test-fleet-orchestration.mjs` 全绿(1.x/2.x/3.x 用例)
- [x] 4.2 十套既有回归零新增红(schedule 逐字节等价门);`openspec validate add-fleet-orchestration` 通过
- [x] 4.3 出片(随下一列车,与 errorKind 校准/bundled 自激活同车)+ 真机验收(supervisor 双岗派活闭环 + pipeline 三岗链)+ 台账补记
