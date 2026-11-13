# Proposal: add-facet-intro-hero

## Why

facet.finddatatech.cloud 薄壳（facet/web）两 tab（功能集/MCP 服务）落地即市场
列表：访客看到卡片墙，不知道谦面是什么、和壹座什么关系、编辑器用户怎么装。
产品域缺第一面。2026-10-05 grill 共识：范围 C（产品域+官网两层都补）、双层口吻
（价值定位 hero + 可动手 quick facts）；谦面侧形态定为 hero 带——守薄壳哲学，
不新增视图。

## What Changes

- **hero 带**：`facet/web` App.tsx header 之下、tab 内容之上插入一条静态介绍带，
  两 tab（功能集/MCP 服务）常驻、不可关闭、紧凑（约 1/4 屏高，市场卡片保持
  首屏可见）。
- **内容（双层口吻）**：价值定位一句「AI 编辑器的功能集与工具分发市场」+ 三个
  quick facts：浏览·订阅·发布功能集 / MCP 服务目录 / CLI 一行安装。
- **CLI 事实单源**：只用已发布真名
  `npx @finddatatechonology/facet install <包 id>`——与页脚既有提示同一事实，
  hero 落地后页脚提示与其去重（并入 hero 或简化，实现时定）；不写任何未验证
  数字（市场包数等）。
- **i18n**：文案走 i18n key（zh-CN + en 撰写，es/fr/ja 走 fallbackLng），不
  硬编码中文。
- **官网互链**：hero 带官网谦面线页链接，按当前 locale 切换
  （zh→`/zh/products/facet`，en 及 fallback→`/products/facet`）。
- **薄壳边界**：纯展示零交互——不新增视图/路由/本地状态；不触碰 PackMarketView
  与 McpCatalog。

## Capability Impact

- ADDED `facet-platform`：新 requirement「facet web 壳携带产品介绍带」（静态、
  i18n key、两 tab 常驻、CLI 事实单源可验证、官网线页回链随 locale）。既有
  requirement 均不动。

## Non-goals

- 谦面域独立介绍路由/关于页（薄壳哲学，hero 带为止）；活数据（市场/目录计数）；
  官网侧改动（fd-official-web 仓 `add-facet-wanxing-apps` 另立）；萬星侧改动
  （fd-wanxing 仓 `add-intro-view` 另立）；facet/web 测试基建（静态带不建测试缝）。

## 验收口径

- `npm --prefix facet/web run build` 绿；本地目检（两 tab 常驻、zh/en 切换、
  线页链接目标随 locale、页脚去重后无重复 CLI 提示）；随 paas 主镜像部署
  fd-prod 后探针（title 不变 + hero 关键词出现在渲染 DOM）。前端零新单测
  （facet/web 无测试缝，静态带不成比例建基建；与仓内前端验收惯例一致）。
