# Tasks — add-app-center（壹座 Y1 应用中心）

## 1. 实施

- [x] 1.1 `web/src/lib/appCatalog.ts`：五线条目单源（id/名称键/tagline 键/url/status），
      附形状单测（五线齐、url 域名合法、status 枚举）
- [x] 1.2 `AppCenterPage.tsx`：产品线卡片区（状态徽标+直达新标签）+ 平台应用区
      （fetch /api/catalog 过滤 external-service，空则隐藏）+ ErrorBoundary 家法
- [x] 1.3 `Sidebar.tsx` NAV_BASE 增「应用」项 + `App.tsx` /apps 懒加载路由
- [x] 1.4 五语词条（nav.apps + appCenter.* 五文件同键集，check-locales 绿）
- [x] 1.5 e2e `app-center.spec.js`：导航可达+五卡渲染+外链行为+平台应用区降级

## 2. 上线与收口

- [x] 2.1 commit + 出片（GHA 阻断则 scs001 错峰：与并行会话的 deploy-snapshot
      分支错开，push 前先 fetch scs001）+ GitOps 双清单滚
- [x] 2.2 生产实证：/apps 五卡+平台应用区渲染；浏览器已登录态直通谦面/萬星
      记录 SSO 实证结论（逐线：直通/需再点登录）
- [x] 2.3 归档（validate --specs 通过后）+ `docs/yizuo-platform-roadmap.md` Y1 标 ✅
