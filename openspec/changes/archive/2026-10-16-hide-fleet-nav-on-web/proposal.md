## Why

`/fleet`（萬星舰队）是 v1.3.12 桌面萬星插件线的产物：桌面 App 内嵌 runner，「本机舰队」读的是**桌面进程**的健康快照。但侧边栏导航（`Sidebar.tsx` `NAV_BASE`）无条件渲染该入口，纯浏览器用户也看得到——点进去是两个**永远为空**的读区（托管 cell 无 seat runner、网页无 registry 配置），页脚的「届时本机位可作为部署目标」对网页访客同样无上下文。2026-10-16 用户在网页端实际撞到并质疑。只读+标准鉴权，无安全问题，纯产品面噪音。

## What Changes

- 侧边栏的「萬星舰队」入口**只在 Electron 桌面壳内渲染**（检测 = preload bridge 存在，`window.platform`——`Sidebar.tsx` 里 `CAN_PICK_NATIVE` 已在用的同款惯用法）。
- 纯浏览器直达 `/fleet` 路由渲染一个桌面专属说明页（不轮询两个代理端点），替代两个恒空读区。
- 桌面端行为逐字节不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `desktop-fleet-console`: 舰队页与导航入口限定在 Electron 桌面壳内可达；浏览器直达落说明页。

## 边界

- 不动 `/api/wanxing/fleet/live`、`/api/wanxing/fleet/catalog` 两个代理端点（标准 cell 鉴权已覆盖，藏 UI 不动 API）。
- 不做桌面 App 之外的任何「本机」能力。
