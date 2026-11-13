# Design: add-cockpit-ops-loop

## Decisions

### D1 · 立即交付 = 复用任务运行通道,零后端

memberView 已暴露 `taskId`;按钮 onClick 调既有 `POST /api/cron/:id/run`,响应 `already` 诚实提示「已在执行」。无 taskId 不渲染按钮。不新建临时任务(无节奏岗位的「跑一轮」语义留待后续裁定)。

### D2 · 抽屉自刷新 = 订阅 fleet store version

MemberInspector 取 `useFleetStore(s => s.version)` 入 effect deps,version 变化即重拉 turns/reports/decisions(挂载时的三个装载函数复用);概况页签数据来自 member prop,由页面既有节流重拉通道更新。不按事件逐条过滤——version 粒度足够,重拉幂等。

### D3 · 兜底轮询 = 页面可见期 60s setInterval

FleetsPage 挂载后 `setInterval(60s)`:仅 `document.visibilityState === "visible"` 且有选中舰队时调 loadDetail;`visibilitychange` 立即补拉一次(切回页面即新鲜)。不做成可配置(设计裁定:频率不该是用户负担)。

## Risks

- [轮询与事件节流重拉叠加] → 60s 周期与事件节流(2s)通道同一 loadDetail,幂等;频率远低于事件流。
- [立即交付对 in-flight 岗位] → run 通道自带 already 语义,提示而非报错。
