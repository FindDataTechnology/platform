# Tasks: add-fleet-event-wake

## 1. 契约与校验

- [x] 1.1 turn-request:`SOURCES`+event、RESERVED 只余 peer、`buildTurnRequest` 派生(origin.event→source=event/depth=0);读面 source 值集两处(fleets.js turns 端点/architect 桥)加 event;验证:派生两断言+保留位只剩 peer 拒绝
- [x] 1.2 `validateOrchestration` event 边分支(from 形状 bot:xxx/to∈persona,a2a/不入 DAG);验证:三态用例(过/cluster 拒/tool 拒/形状拒)

## 2. 唤醒器与接线

- [x] 2.1 新模块 `server/fleet-event-wake.js`:扫边建任务(origin 两段/prompt 发送者+原文/每岗每小时≤30 env 可配,超限落 O1 事件);`server.js` ctx 接线 + `bots.js` handleMessage 守卫后一处触发(缺省静默);验证:注入 engine 断言任务形状/未命中零扰/护栏超限
- [x] 2.2 新增 `scripts/test-fleet-event-wake.mjs` 全绿

## 3. 回归与出片

- [x] 3.1 十三套回归零新增红;`openspec validate add-fleet-event-wake` 通过
- [x] 3.2 出片随攒车列车 + 真机验收(声明 event 边→bot 发消息→岗位 source=event 事件)+ 台账补记
