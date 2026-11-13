# fix-facet-packs-crash

## Why

R4（`31bcd06`，2026-10-11 上线）给共享组件 `PackMarketView` 加了无条件的 `useNavigate()`（订阅向导弹「打开对话」跳 `/chat`），壹座壳有 `BrowserRouter` 所以无恙；谦面薄壳按规格不挂任何 router（facet-platform：「the shell SHALL add no router dependency」），`useNavigate()` 在无 Router 祖先下挂载即抛错，无 ErrorBoundary 兜底导致 React 卸载整棵树。生产实锤（2026-10-12 探测）：`https://facet.finddatatech.cloud/#/packs` 整页白屏（连头部在内），intro/mcp 正常，控制台报 `useNavigate() may be used only in the context of a <Router> component`。功能集市场自 10-11 起对公众不可用。

## What Changes

- `PackMarketView` 的路由依赖收敛进向导页脚子组件：`useNavigate()` 只在页脚实际渲染时调用，且页脚行为可由宿主注入（`onOpenChat` prop：缺省 = 壹座行为 `navigate("/chat")` 不变；传 `null` = 不渲染页脚）——共享组件对宿主壳的路由上下文无感。
- 谦面壳（facet/web）对 packs 视图传 `onOpenChat={null}`：订阅报告照常弹出，向导页脚不渲染（对话是壹座面，谦面无 `/chat` 可去；与既有「安装到运行时请在壹座内完成」的指引语义一致）。
- 谦面壳加 ErrorBoundary：任一视图渲染抛错时壳存活（头部/页签/页脚在位），主区显示内联错误条，不再整页白屏。
- 补谦面壳冒烟 e2e：三个视图逐一渲染断言（intro 落地、packs 出现功能集卡片、mcp 出现目录），防「共享组件在壹座语境演进、谦面壳零测试网」再次静默炸壳。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `facet-platform`：
  - MODIFIED「Shell views are addressable hash routes」——借用的壹座视图（packs 市场）在无 router 祖先的谦面壳上 SHALL 完整渲染；新增场景「借用视图不要求路由上下文」。既有三场景（deep link and refresh / tab and hash stay in sync / unknown hash falls back）全部保留。
  - ADDED「A view failure cannot blank the shell」——任一视图渲染抛错时壳与页签存活并显示内联错误。
- `pack-marketplace`：
  - MODIFIED「Subscribing ends with a next-steps wizard」——向导弹页脚的 open-chat 按钮是壹座面 affordance（跳壹座对话视图）；在谦面壳上页脚不渲染，订阅报告本体不变。场景「the report offers the next step」保留并按壳区分行为。

## Impact

- `web/src/components/packs/PackMarketView.tsx`：`useNavigate` 移入页脚子组件 + `onOpenChat` prop（壹座调用点零改动，缺省路径行为不变）。
- `facet/web/src/App.tsx`：packs 视图传 `onOpenChat={null}`；包 ErrorBoundary。
- `facet/web/src/`（新）：ErrorBoundary 组件。
- `e2e/`：谦面壳冒烟 spec（facet 服务本地起匿名面 + `facet/web` 构建产物）。
- 不动后端：facet 服务与 `/api/packs*` 全绿，事故纯前端。
- 部署：壹座镜像与 facet 壳同仓同滚（facet 壳 bundle 由同一 GHA→TCR 线出片）。
