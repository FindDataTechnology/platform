# Proposal: add-cockpit-ops-loop

## Why

驾驶舱的运营闭环缺三件套:看到岗位异常想手动跑一轮,得离开驾驶舱去自动化页找任务;检查器打开期间回合结束,抽屉里的回合/产出不刷新;WS 断流时驾驶舱静默过期(现有自愈靠事件到来触发,断流时无事件即无自愈)。

## What Changes

- 检查器配置页签增「立即交付」:经既有任务运行通道(POST /api/cron/:id/run)立即执行该岗既定任务;无既定任务(被动岗未绑)时按钮不出现,诚实降级。
- 检查器打开期间订阅舰队事件:该岗回合结束时自动重拉回合/产出页签,概况随页面节流刷新保持一致。
- 驾驶舱兜底轮询:页面可见时每 60s 整体重拉一次,WS 断流最终一致;不可见时暂停。

## Capabilities

### New Capabilities
(无)
### Modified Capabilities
- `agent-fleet-cockpit`: ADDED——检查器即时交付(复用任务运行通道,无任务诚实降级)、抽屉随回合结束自刷新、页面可见期低频兜底轮询。

## Impact

- 前端:`InspectorDrawer.tsx`(按钮+订阅)、`FleetsPage.tsx`(兜底轮询)、i18n 五语言一键。
- 复用 `POST /api/cron/:id/run`,零后端改动。
- 非目标:不做无任务岗位的临时任务创建;不改轮询频率配置化。
