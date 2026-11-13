# Tasks: add-fleet-canvas-drag

- [x] 1.1 FleetCanvas 受控化:节点入 useState + onNodesChange(applyNodeChanges),nodesDraggable 开启;验证:tsc/biome 绿,拖动时节点随手移动、实时事件仍不触发布局重排
- [x] 1.2 位置持久化:onNodeDragStop 写 localStorage(键 `platform.fleetCanvas.<fleetId>`,JSON {v:1,p}),初始化按存档覆盖种子位置,损坏存档静默回落;FleetsPage 传 fleetId;验证:单测/构造断言 存取往返、损坏 JSON 回落
- [x] 1.3 恢复自动布局按钮(图例行)+ i18n 五语言;验证:e2e 拖动→刷新位置保持→重置→刷新回种子
- [x] 1.4 `e2e/fleets.spec.js` 画布 describe 增拖拽持久化用例;验证:fleets e2e 全绿;出片随下班车+浏览器眼见
