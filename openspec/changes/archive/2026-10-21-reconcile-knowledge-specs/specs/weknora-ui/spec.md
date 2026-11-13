## REMOVED Requirements

### Requirement: WeKnora UI is accessible via the React SPA's sidebar navigation
**Reason**: 代码 2026-08-04 当天移除（`ef60adcf`）；SPA 无 `/weknora` 路由，侧栏知识入口指向 `/knowledge`（DocumentsPage）。
**Migration**: 现管 UI 真源 = `document-management-ui`。

### Requirement: WeKnora UI replaces the first-party Documents page
**Reason**: 替换关系当日即被反转——被「替换」的一方（Documents 页）存活至今并经 2026-09-12 重建为文件库页面。
**Migration**: `document-management-ui`（`/knowledge` 路由，`/documents` 重定向）。

### Requirement: WeKnora UI is embedded via same-origin iframe proxy
**Reason**: 代理与 iframe 均随 WeKnora 整链移除；同源 iframe 代理模式若未来复活，按 `/oc-web`、`/litellm-web` 既有先例另行立项。
