## Context

两个纯前端小修，根因都已在 explore 阶段定位到行：

1. `{{brand}}`：`web/src/pages/ChatPage.tsx:108` 的移动端紧凑顶栏调用 `t("sidebar.brand")` 时漏传 `{ brand }` 插值变量；对照正确写法 `web/src/components/Sidebar.tsx:272`（`t("sidebar.brand", { brand })`，brand 来自 `useBranding()`）。i18next 在缺插值变量时原样输出占位符，且该顶栏 `md:hidden`，故仅手机端可见。
2. iOS 聚焦整页放大：`web/src/components/Composer.tsx` 的 textarea 用 `text-sm`（14px）；`web/index.html:5` 的 viewport 无缩放限制。iOS 对 <16px 的可聚焦输入框会强制放大页面，微信内置浏览器失焦后常不还原 —— 用户真机症状（整页放大、`+` 按钮半出屏、文字叠挤）与此吻合；Chrome 桌面模拟 390px 下 DOM 矩形实测无重叠、无出界，排除布局本身问题。

## Goals / Non-Goals

**Goals:**
- 移动端顶栏显示插值后的 brand 名，任何 locale/branding 状态不露出原始占位符。
- 移动端聚焦输入框不触发 iOS 自动缩放；桌面视觉零变化。

**Non-Goals:**
- 不改 `sidebar.brand` 的 i18n key 结构，不引入 i18n `defaultVariables` 全局机制（branding 是运行时配置，逐调用点传参是仓库既定模式）。
- 不用 `maximum-scale=1` / `user-scalable=no`（无障碍）。
- 不处理 `packages/core`、wire 协议或服务端 —— 那属于 `add-reconnect-resync`。

## Decisions

- **③ 修调用点而非全局默认插值**：`useBranding()` 已封装 brand 解析（`assistantName` 回退 `assistant.brand`），ChatPage 顶栏照 Sidebar 的写法传入即可，一行改动、影响面封闭。备选的 i18n `defaultVariables` 需要在 i18n 初始化时拿到运行时 branding，引入时序耦合，不值。
- **① 用 `max-md:` 前缀仅移动端升 16px**：桌面 14px 是既定视觉（composer 与周边 UI 的字号层级），全端 16px 会动到桌面观感。Tailwind 的 `max-md:text-base` 一类工具类即可，无自定义媒体查询。
- **顶栏内容保持 brand 名**（拷问已定）：与桌面 Sidebar 同源同值，不接会话标题。

## Risks / Trade-offs

- `max-md:` 断点与项目 Tailwind 版本的前缀写法需核对（`max-md:` 需 Tailwind ≥3.4 max-variants；若不可用则用等价的 `text-base md:text-sm`）。实现时确认一下构建产物即可，属任务内动作。
- iOS 各浏览器对 16px 阈值行为一致（WebKit 判定），但老版 iOS 偶有 17px 之说 —— 16px 是社区共识阈值，真机验收兜底。
- 无回归风险面：两处改动均为展示层，不触协议与状态。
