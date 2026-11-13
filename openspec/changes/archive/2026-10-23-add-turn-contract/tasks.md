# Tasks: add-turn-contract

## 1. 契约模块(纯函数)

- [x] 1.1 新模块 `server/turn-request.js`:`buildTurnRequest(job)` 按 D2 映射派生(source/targetRef/brief/evidence/resultSink/depth/budget);常量真源 `SOURCES`/`RESERVED_SOURCES`/`RESULT_SINKS`/`RESERVED_RESULT_SINKS`/`DEPTH_BOUND` 导出;`assertTurnRequest` 结构化拒绝保留位与超深度(文案指明 O3/O4/O5 去向);验证:派生矩阵单测全过
- [x] 1.2 `server/fleet-events.js` 改为消费 `buildTurnRequest`(单一定源;`turnSourceFor` 退役为薄别名);验证:O1 事件字段与三源判定用例逐字节不变(turn-events 套件原样绿)

## 2. 测试与等价

- [x] 2.1 新增 `scripts/test-turn-request.mjs`:六路径派生矩阵(cron 舰队/execute-now origin/delegation initiator/a2a depth1/非舰队 cron/非舰队 manual)、保留源拒绝、超深度拒绝、budget/evidence 透传;全绿
- [x] 2.2 八套舰队套件全量回归零新增红(等价 harness);`openspec validate add-turn-contract` 通过
- [x] 2.3 出片(server/ 有改动)——**与 turn-events/architect 同列车**(攒车中)
