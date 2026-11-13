# Design — polish-facet-interactions

## Context

见 proposal.md。三处交互问题同源：共享弹窗组件与谦面壳之间只有数据通道没有语义通道（登录态、宿主能力都没传），页脚则是一个组件扛两种职责（营销叙事 + 合规备案）。事实：`dialog.tsx` 无 DialogClose（唯一关闭=Esc/遮罩）；订阅按钮在内容流末尾（弹窗 max-h-85vh 内部滚动）；匿名 401 由 `subscribe()` catch 原样 setError；logto-auth 已有 `safeReturnPath`（同源 rd 回跳，可带 hash）；弹窗唯一挂载点 = PackMarketView（壹座 PacksPage 与谦面壳共用）；壳已有 user 状态（App.tsx）与 `/auth/login` 整页跳转先例。

## Goals / Non-Goals

- Goals：备案行全站常在；营销内容归落地页；弹窗决定性动作常驻可见 + 匿名有登录路径；部署节自解释。
- Non-Goals：不做弹窗状态恢复（登录回来重开即得）；不动 deploy 语义与权限；不做帮助中心式长文案；不改 dialog.tsx 基建（底栏在 PackDetailDialog 内实现）。

## Decisions

1. **slim 页脚 = PageFooter 新导出 `FilingFooter`，非 variant prop。**
   两个形态内容重叠度低（slim 只有一行备案），独立组件比分支更清晰；完整 PageFooter 不动（intro 专用）。App 按 `view === "intro"` 二选一。备案行三事实（copyright/ICP/MPS 链接）抽为两组件共享的常量+行片段，单一事实源防漂移。

2. **底栏 = 弹窗内 sticky footer（`sticky bottom-0`），不是 Radix DialogFooter 之外的浮层。**
   DialogContent 是 overflow-auto 容器，sticky 让底栏钉在可视底沿、内容从其下滚过——实现最小且随主题。结构：`border-t bg-background/95 backdrop-blur px-4 py-3 flex items-center gap-2`。订阅主按钮 + 关闭次按钮（`variant="ghost"` ✕ 图标 + aria-label）。原内容流里的订阅按钮块删除（不双份）。onGotoMine 有值才渲染（谦面不传即消失）。

3. **登录态通道 = `onRequireLogin?: () => void` 回调 prop，不是 boolean。**
   宿主决定"未登录时点订阅"的行为（谦面：置位内部 guiding 状态→内联引导行；回调触发即底栏翻出引导行）。弹窗内部不判断登录——它只管"宿主说没登录就走这条路"，壹座不传=走既有 catch 兜底（401 文案本地化映射 `packs.detail.authRequired`）。引导行里的「去登录」按钮也是回调的一部分（谦面壳传 `() => window.location.href = "/auth/login?rd=" + encodeURIComponent(location.href)`——safeReturnPath 收同源绝对 URL，回 #/packs）。

4. **部署节文案全走 i18n 键（五语），不内联。**
   与 MineView 的双语内联不同——这节是共享组件，壹座侧也渲染，必须走既有五语 parity 门。新增键 ~6 个（deploySummary/keySubtitle/rhythmSubtitle/deployOutcome/authRequired/loginHint），zh-CN 为主文案，其余四语翻译。check:locales 门自动把 parity。

5. **e2e 落哨兵 spec（facet-shell）+ 壹座 packs.spec 核对。**
   facet-shell：#/packs 细页脚断言（ladder 缺席+备案行在）、#/intro 完整页脚断言、弹窗底栏常驻（长包详情不滚动即可见订阅+关闭）、匿名点订阅→引导行出现。壹座 packs.spec：订阅相关既有用例按钮 testid 不变（`pack-subscribe` 保留），预期零改动即绿即回归证明。

## Risks / Trade-offs

- [底栏遮挡内容末尾] → DialogContent 底部 padding 增加底栏高度等量空间；sticky 不遮，只是占位。
- [401 本地化映射可能漏其他错误形状] → 只映射 `Authentication required` 精确匹配，其余原样（不扩大兜底面）。
- [rd 带 hash 的回跳] → safeReturnPath 保留 hash（`url.pathname+search+hash`），#/packs 可回；弹窗不恢复已定 Non-Goal。

## Migration Plan

壹座与谦面同镜像滚动（同仓同线）。无数据迁移。回滚=revert。上线后线上复验：slim 页脚（#/packs）、完整页脚（#/）、弹窗底栏、匿名引导行。

## Open Questions

（无——六问全部按推荐答案收口于 explore 轮。）
