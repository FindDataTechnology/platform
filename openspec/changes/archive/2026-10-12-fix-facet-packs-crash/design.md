# Design — fix-facet-packs-crash

## Context

见 proposal.md —— 共享组件 `PackMarketView` 在壹座语境演进（R4 引入 `useNavigate`），谦面壳按规格不挂 router，借用即炸。后端无恙，纯前端事故。修复要同时做两件事：让这次炸不了，让下次炸不成。

## Goals / Non-Goals

- Goals：#/packs 恢复；谦面壳的路由免疫从「约定」变「被测事实」；视图级故障被围堵。
- Non-Goals：不引入 MemoryRouter（等于给壳加 router 依赖，与规格「no router dependency」相悖）；不搬壹座对话页到谦面；不做谦面指向壹座对话的跳转链接（留给内容管理 change 按产品语义定）；不动 facet 服务端与 `/api/packs*`。

## Decisions

1. **路由收敛进页脚子组件，而非组件级 prop 注入 navigate。**
   把 `useNavigate()` 从 `PackMarketView` 顶层移入向导弹页脚子组件（只在页脚渲染时才调用），并给页脚一个 `onOpenChat?: (() => void) | null` 注入点：缺省 = 壹座行为（`navigate("/chat")`）原样保留，`null` = 页脚整体不渲染。
   - 备选否决 A（壳包 MemoryRouter）：壳获得 router 依赖，违反 facet-platform 既有 SHALL；且「打开对话」按钮变成静默死钮——坏行为只是从崩溃变沉默。
   - 备选否决 B（PackMarketView 接收 navigate 回调 prop、壹座调用点全部改传）：动壹座调用面，收益不比方案 1 多。
   - hooks 规则决定了 `useNavigate` 不能条件调用——所以收敛点必须是被条件渲染的子组件，这是方案成立的关键。

2. **谦面侧传 `onOpenChat={null}`（页脚不渲染），不是「跳去壹座」。**
   谦面订阅后本就提示「安装到运行时请在壹座内完成」（501 软拒），向导弹「打开对话选专家」在谦面语境不成立。跨域跳壹座对话 URL 需要新的环境配置（谦面服务端没有壹座基址 env），超出紧急修复的范围。

3. **ErrorBoundary 放壳层，包每个视图的 main 区。**
   React 官方 class 边界（函数组件无等价物）。fallback = 内联错误条 + 「重试」（重置边界内部状态重挂载视图）。头部/页签/页脚在边界外，结构上不可能被视图故障带走。

4. **冒烟 e2e 起真 facet 服务 + 真 facet/web 构建，不用 stub。**
   `node facet/index.js` 无 Logto 配置可匿名面启动（代码既有降级路径）；webServer 起 vite preview（或直接 serve `facet/web/dist`）。spec 断言：intro 落地、#/packs 出现 `[data-testid^=pack-card-]`、#/mcp 出现目录面。这条网的意义在「共享组件在壹座演进时谦面壳有哨兵」，stub 教不了这个。
   - 注意 facet/web 构建产物在 CI 的既有链路里是否已构建——若快照/发布管线已含则复用，否则 e2e 前置一步 `npm run build`（facet/web 有独立 package.json）。

5. **壹座侧零行为变化**：`PackMarketView` 缺省路径 = 现状（页脚渲染 + navigate("/chat")）；壹座 e2e（packs.spec 向导弹 3 用例）不改预期即应全绿——这本身就是回归证明。

## Risks / Trade-offs

- [PackDetailDialog 等其他借用组件未来再引入路由依赖] → 冒烟 e2e 是哨兵（#/packs 卡片断言会先于用户炸）；ErrorBoundary 是围堵（炸了也只损失该视图）。双保险成立，不追求静态分析级防护。
- [`onOpenChat=null` 后谦面订阅报告缺「下一步」指引] → 报告本体（分部件状态+关闭）完整；谦面的下一步指引语义本就由 501 软拒文案承担。跨域指引留给内容管理 change。
- [facet/web 在 e2e 里需要独立构建，CI 时长微增] → 构建秒级（thin shell），可接受。

## Migration Plan

同仓同滚：修复进 main → GHA→TCR 出片 → fd-prod facet deployment 滚动。回滚 = revert 同滚。无数据迁移、无 API 形状变化。上线后线上复验：#/packs 出卡片、控制台无 PAGEERROR。

## Open Questions

（无——跨域「打开壹座对话」指引的产品语义留给 add-facet-content-management，不影响本 change 的形状。）
