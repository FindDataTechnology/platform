## REMOVED Requirements

### Requirement: Knowledge Collection panel
**Reason**: 所述面板（pageindex 知识集合面板）随 2026-09-12 文件库重建（BREAKING）移除；`/knowledge` 路由现渲染文件库页面。
**Migration**: `document-management-ui`（`/knowledge` 路由 + `/documents` 重定向）。

### Requirement: Add documents of multiple types
**Reason**: 面板形态的上传入口随重建更换为文件库页面的上传 affordance。
**Migration**: `document-management-ui` 的上传需求。

### Requirement: Auto-save indication and live status
**Reason**: 异步索引的状态指示随管线移除，现为同步摄取状态 + 看门狗。
**Migration**: `document-management-ui` 的状态呈现需求。

### Requirement: Browse and manage the collection
**Reason**: 浏览/管理由文件库页面接管（列表、状态、内容预览、删除、集合分组、「开始对话」）。
**Migration**: `document-management-ui`。

### Requirement: Query the collection with source attribution
**Reason**: 2026-09-12 重建的显式 BREAKING 决策——页面级查询框删除，对话窗口成为唯一问答入口；溯源以工具命中（文档名 + 定位符）经 agent 工具面呈现，非一方引用 UI。
**Migration**: 问答走聊天 + `document-library-tools`（`search_library` 命中带文档名与定位）。

### Requirement: Reconnect resilience
**Reason**: 面板级重连刷新语义随面板移除；重连后的初始状态重放由通用 WS 层承接（`useWebSocket` 重连重放既有查询）。
**Migration**: 通用重连重放行为（无独立 spec 承载，作为实现事实记录于本 Reason）。
