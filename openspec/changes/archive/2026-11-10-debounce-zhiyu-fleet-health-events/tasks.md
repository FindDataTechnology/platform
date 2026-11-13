# Tasks — debounce-zhiyu-fleet-health-events

> 单组实现，三项各有验证。零假绿：未跑的不勾。

## 1. 实现

- [x] 1.1 `gateway/fleet-room-bridge.js`：健康分支改「持续态」判定——偏离提交态时记 `pending:{value,since}`，同值且 `now-since >= healthSettleMs` 才落行并提交 `abnormalCount`；翻回提交态则清 pending 并 `healthFlaps++`，不落行；验证：新增单测「抖动期零事件行 + 稳定后一行带尾注 k」
- [x] 1.2 观察态持久化：watermark JSON 增 `healthPending`/`healthFlaps`（缺字段视为无 pending，向后兼容旧行）；验证：单测断言两次 tick 之间读库能看到 pending，且重建 bridge 实例后仍按同一 pending 结算
- [x] 1.3 结束房清 pending：`!flowing` 分支提交 `abnormalCount = 当前值` 并清 `healthPending`/`healthFlaps`；验证：单测「断流期迁移 → 重开不补发、pending 已清」
- [x] 1.4 配置：`registerFleetRoomBridge` 增 `healthSettleMs`（默认 `env.ZHIYU_HEALTH_SETTLE_MS` 或 10 分钟）与可注入 `nowMs`（测试用，生产默认 `Date.now`）；验证：默认值断言 + 注入时钟的用例通过

## 2. 回归

- [x] 2.1 `node --test scripts/test-zhiyu-room-lifecycle.mjs`（新增 3 例）+ `test-fleet-room-bridge.mjs`（既有 10 例不得红）；验证：13 + 10 全绿
- [x] 2.2 全链 zhiyu 十套件回归；验证：84/84 绿
- [x] 2.3 `openspec validate debounce-zhiyu-fleet-health-events --strict`；验证：绿

## 3. 收口

- [x] 3.1 提交并隔离 clone 推送（远端被并发推进会重试）；验证：fetch 后远端 tip 含该提交
- [x] 3.2 上产后观察——**代码在产已证**（镜像 `sha-ee3e876` 的 `zy_fleet_subs.watermark` 含 `healthPending`/`healthFlaps` 两键，只有新代码会写；单测覆盖抖动合并/持续态/重开清 pending）。**活房抖动样本的观察**转入 `verify-zhiyu-live-eyes` 任务 2.1（现网两间订阅房均已结束，无可观察对象）
