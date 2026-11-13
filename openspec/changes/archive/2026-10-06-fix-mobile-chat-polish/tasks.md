## 1. {{brand}} 移动端顶栏修复

- [x] 1.1 `web/src/pages/ChatPage.tsx`：引入 `useBranding`，移动端紧凑顶栏（`md:hidden` 头部）改为 `t("sidebar.brand", { brand })`，与 `Sidebar.tsx:272` 同源
- [x] 1.2 验证：390px 视口下顶栏显示 brand 名（无 branding 覆盖时为 locale 默认值如 `Platform`），全 locale 抽查不再出现 `{{brand}}` 原文；桌面端不受影响

## 2. iOS 聚焦自动缩放修复

- [x] 2.1 `web/src/components/Composer.tsx`：textarea className 增加移动端 16px 字号（`max-md:text-base` 或等价 `text-base md:text-sm`，按项目 Tailwind 能力择一），确认不引入 `maximum-scale`/`user-scalable` 限制
- [x] 2.2 验证：390px 视口 computed font-size ≥16px；`md` 及以上断点仍为 `text-sm`(14px)；移动端聚焦输入框页面不缩放（iOS 真机或 WebKit 模拟验收）

## 3. 回归与收尾

- [x] 3.1 跑 web 既有构建/测试基线（`vite build` + 相关单测），确认零回归
- [x] 3.2 Playwright 冒烟：移动视口走一遍「打开抽屉→选会话→聚焦输入→发送」，截图核对顶栏与输入区
- [x] 3.3 走 canonical 上线路径（GHA→TCR）部署 fd-prod，真机复验两项症状消失
