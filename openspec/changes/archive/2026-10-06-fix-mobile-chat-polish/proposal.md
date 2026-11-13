## Why

手机端（微信内置浏览器/移动 Safari）当前有两个可见缺陷：对话页移动端顶栏把 i18n 占位符原样显示为 `{{brand}}`；点击输入框聚焦时 iOS 因输入框字号 <16px 强制整页放大，且微信浏览器失焦后经常不还原，导致元素出屏、文字叠挤。两者都是 2026-10-04 真机截图实测确认的问题（前者已在本地 390px 视口复现）。

## What Changes

- 移动端紧凑顶栏（`md:hidden` 头部，`web/src/pages/ChatPage.tsx`）的品牌文案从 `t("sidebar.brand")`（缺 `{ brand }` 插值 → 原样输出 `{{brand}}`）改为与桌面 Sidebar 同源的 `t("sidebar.brand", { brand })`，brand 取自 `useBranding()`。
- Composer textarea（`web/src/components/Composer.tsx`）在移动端视口（`max-md:` 级媒体查询）将字号提到 16px（`text-base`），防止 iOS 聚焦自动缩放；桌面端保持 14px（`text-sm`）既定视觉不变。不使用 `maximum-scale=1`（保住无障碍缩放）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `chat-ui-shell`: 新增移动端紧凑顶栏的品牌显示要求 —— 顶栏显示的 brand 名必须是插值后的值，任何情况下不得渲染原始占位符。
- `chat-composer-controls`: 新增输入框移动端字号要求 —— 移动端视口下 textarea 字号 ≥16px，聚焦不得触发 iOS 视口自动放大。

## Impact

- 代码：`web/src/pages/ChatPage.tsx`（一行 + `useBranding` 引入）、`web/src/components/Composer.tsx`（className 增加移动端字号工具类）。
- 不动 wire 协议、不动服务端、不动 `packages/core`。
- 回归面小：桌面视觉零变化（`max-md:` 限定）；i18n 其它 `{ brand }` 调用点（`Sidebar.tsx:272`、`useAppConfig.ts` 的 `assistant.name`）已正确传参，不受影响。
- 验收：390px 视口下顶栏显示 brand 名而非 `{{brand}}`；移动端聚焦输入框页面不缩放；桌面端输入框仍为 14px。
