# add-app-center

## Why

壹座 roadmap（`docs/yizuo-platform-roadmap.md`，2026-10-13 定案）Y1 第一片：融合档位已
拍板为**项目联邦**——各产品线保持独立项目身份，壹座做门户+承载层。但壹座 web 现在
`/` 直跳 `/chat`，**没有发现面**：登录用户在壹座里看不到「平台上有哪些产品线、去哪
用它们」。同时五线的入口分散（谦面/萬星 LIVE、识律/柏讯占位页），用户无从建立
「壹座是平台，这些产品运行其上」的心智。

## What Changes

壹座 web 新增**应用中心**页（登录后导航项）：

- 新路由 `/apps` + 导航项「应用」（NAV_BASE 第六项）
- **产品线区**：寻数五线卡片（壹座/谦面/萬星/识律/柏讯）——每张卡片=图标+名称+
  一句话定位+状态徽标（live=可用 / early=建设早期，如实降级不撒谎）+「打开」直达
  （新开标签到各线自有域名）。条目数据单源硬编码 `web/src/lib/appCatalog.ts`
  （品牌事实，不常变；介绍内容归各线官网，壹座只放一句话+链接，不复制内容）
- **平台应用区**：聚合服务端 external-service 目录（`GET /api/catalog` 过滤
  `kind === "external-service"`，现含 NEW API）——嵌入应用从 AgentsPage 深处提升到
  发现面；目录为空或角色不可见时诚实降级隐藏该区
- SSO 直通不在本片做验证面改动：五线统一 Logto 同租户，卡片直达即 SSO 跳转路径；
  逐线实证作为任务 2.2 的记录项（curl/浏览器验证已登录态直通谦面/萬星）

## Capabilities

### New Capabilities

- `app-center`: 壹座 web 的产品线发现面——五线卡片（状态如实+直达）与平台内嵌
  应用聚合（服务端目录驱动），登录可达，五语文案齐全。

### Modified Capabilities

（无——Sidebar NAV_BASE 增项与 App.tsx 增路由是纯增量接线，无既有行为变更）

## Impact

- **新增**：`web/src/pages/AppCenterPage.tsx`、`web/src/lib/appCatalog.ts`、
  e2e `app-center.spec.js`、五语 `nav.apps`/`appCenter.*` 词条
- **修改**：`Sidebar.tsx`（NAV_BASE +1 项）、`App.tsx`（/apps 懒加载路由）
- **消费**：`GET /api/catalog`（既有，role-filtered；空/无权限→隐藏平台应用区）
- **不触碰**：AgentsPage 的嵌入体验（/external/:appId 保持原位——应用中心只加
  发现入口）、后端、登录态逻辑
