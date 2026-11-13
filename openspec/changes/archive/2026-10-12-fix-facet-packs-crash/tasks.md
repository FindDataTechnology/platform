# Tasks — fix-facet-packs-crash

## 1. 组件修复（壹座侧零行为变化）

- [x] 1.1 `web/src/components/packs/PackMarketView.tsx`：向导弹页脚抽成子组件，`useNavigate()` 移入其中（只在页脚渲染时调用）；页脚接 `onOpenChat?: (() => void) | null`，缺省走 `navigate("/chat")`、`null` 不渲染页脚。验证：壹座 `e2e/packs.spec.js` 向导弹既有 3 用例不改预期全绿。
- [x] 1.2 单测（如组件有伴生单测则补，无则跳过并记录）：`onOpenChat={null}` 时报告面板渲染、页脚与 open-chat 按钮不出现。验证：单测断言通过。
  - [x] 记录：仓内无组件单测基建（web 组件覆盖历来走 e2e）——按「无则跳过并记录」处理；页脚缺省路径由壹座 packs e2e 17 用例（含向导弹 3 用例）覆盖，谦面侧渲染由 facet-shell 哨兵覆盖；ErrorBoundary 围堵经注入式探针实证（错误条/重试/切页恢复/壳存活四断言）。

## 2. 谦面壳修复

- [x] 2.1 `facet/web/src/App.tsx`：packs 视图传 `onOpenChat={null}`。验证：本地起 facet 服务 + facet/web dev，#/packs 出现功能集卡片。
- [x] 2.2 新增 `facet/web/src/ErrorBoundary.tsx`（class 边界：内联错误条 + 重试），壳 main 区每视图包裹。验证：手动抛错视图下头部/页签/页脚存活、切换其他页签正常。

## 3. 哨兵网

- [x] 3.1 谦面壳冒烟 e2e（新 spec，如 `e2e/facet-shell.spec.js`）：webServer 起 `node facet/index.js`（匿名面）+ facet/web 构建产物；断言 intro 落地、#/packs 出现 `[data-testid^=pack-card-]` 且无 PAGEERROR、#/mcp 目录面在位。验证：该 spec 全绿。
- [x] 3.2 本地回归全跑：web 侧 lint/unit/build + 既有 e2e fast 套件不回退。验证：命令退出 0。

## 4. 上线与验证

- [x] 4.1 提交 main → GHA→TCR 出片 → fd-prod facet deployment 滚动（壹座与谦面壳同滚）。验证：rollout 完成、新镜像 sha 生效。
- [x] 4.2 线上复验：`https://facet.finddatatech.cloud/#/packs` 出现功能集卡片、控制台无 `useNavigate` PAGEERROR、#/ 与 #/mcp 不回归。验证：无头探测脚本三断言全过。
- [x] 4.3 openspec 归档（validate --specs 先行，spec 同步并入 facet-platform / pack-marketplace）。
