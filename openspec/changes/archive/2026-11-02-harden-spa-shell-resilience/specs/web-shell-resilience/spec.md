## Purpose

定义壹座 web SPA 壳的容错契约：壳与哈希资产的缓存姿态、路由渲染崩溃时的页内降级、以及懒加载 chunk 失效时的一次性自愈——保证「滚版后旧壳客户端点某页白屏」这类事故不再发生，且任何前端故障都降级为可见、可行动的错误态而非整页空白。

## ADDED Requirements

### Requirement: SPA 壳保持新鲜，哈希资产长驻缓存

服务端（gateway 与单进程 server 两处同形）SHALL 以 `Cache-Control: no-cache` 提供 SPA 壳（`index.html` 及深链回退返回的壳），使浏览器每次导航都向服务器协商壳的新鲜度；SHALL 以 `Cache-Control: public, max-age=31536000, immutable` 提供带内容哈希的静态资产（`assets/` 下构建产物）。壳 MUST NOT 被启发式缓存——滚版后客户端再进入（含普通刷新）MUST 拿到引用新 chunk 的壳。

#### Scenario: 滚版后旧壳客户端拿到新壳

- **WHEN** 部署完成一次滚版（chunk 哈希已变），用户刷新或重新打开站点
- **THEN** 浏览器向服务器协商 `index.html` 并拿到新壳（非启发式缓存命中），新壳引用的 chunk 全部存在于当前 `dist`

#### Scenario: 哈希资产命中强缓存

- **WHEN** 同一构建版本内用户二次加载页面，请求 `assets/` 下带哈希的 JS/CSS
- **THEN** 响应头含 `immutable` 与一年期 `max-age`，浏览器可直接复用本地副本而不发起协商

### Requirement: 渲染崩溃降级为页内错误态而非整页白屏

web 客户端 SHALL 在应用根部持有全局渲染错误边界：任一受边界保护的子树（含懒加载路由）在渲染期抛错时，SHALL 以内容区错误卡替换该子树，错误卡 SHALL 提供「重试」与「重新加载」两个出口；侧边栏、导航与壳 MUST 保持在场。系统 MUST NOT 出现「整棵 React 树卸载、连导航一起消失」的白屏结局。

#### Scenario: 路由渲染抛错只见内容区错误卡

- **WHEN** 某懒加载路由的组件在渲染期抛出异常
- **THEN** 内容区显示错误卡（含重试与重新加载控件），侧边栏与其余壳照常可用
- **AND** 点击「重试」重新渲染该子树，不要求整页刷新

#### Scenario: 错误卡文案五语齐全

- **WHEN** 以 en / es / fr / ja / zh-CN 任一语言打开错误卡
- **THEN** 标题、说明与两个出口按钮均为该语言文案（check-locales 门通过），不出现裸键

### Requirement: chunk 加载失败自动重载一次

客户端 SHALL 识别懒加载 import 失败（动态模块拉取失败 / Loading chunk failed 类错误）为「壳已过期」信号：自动执行整页重载**恰好一次**，并以会话级防环标记保证同一次会话内对同一失败不重复重载。重载后仍失败时 SHALL 落到渲染错误态（由全局错误边界承接），MUST NOT 进入重载循环。

#### Scenario: 旧壳点改版页面自愈

- **WHEN** 持有旧壳的客户端点击一个 chunk 已改名的路由，动态 import 失败
- **THEN** 页面自动整页重载一次，新壳到位后该路由正常渲染，用户无需手动干预

#### Scenario: 重载后仍失败不循环

- **WHEN** 自动重载后该 chunk 依然加载失败（如断网）
- **THEN** 不再触发第二次自动重载，内容区呈现错误卡供用户选择重试或重新加载
