# Tasks — polish-facet-interactions

## 1. 细页脚

- [x] 1.1 `facet/web/src/PageFooter.tsx`：抽出备案行片段（copyright+ICP+MPS 常量与链接行）为共享片段；导出 `FilingFooter`（仅备案行，data-testid="facet-filing-footer"）。验证：build 过。
- [x] 1.2 `facet/web/src/App.tsx`：`view === "intro" ? <PageFooter/> : <FilingFooter/>`。验证：本地 dev 三视图页脚形态正确。

## 2. 弹窗固定底栏

- [x] 2.1 `web/src/components/packs/PackDetailDialog.tsx`：内容流末尾订阅按钮块移入 sticky 底栏（testid 保留 `pack-subscribe`）+ ✕ 关闭按钮（testid="pack-detail-close"）+ onGotoMine 有值才渲染；DialogContent 底部 padding 补偿。验证：壹座 packs.spec 既有用例零改动全绿。
- [x] 2.2 新 prop `onRequireLogin?: () => void`：底栏引导行（testid="pack-login-guidance"）+「去登录」按钮由宿主回调处理；未传走既有 catch 兜底。401 错误兜底本地化（`Authentication required` 精确映射 `packs.detail.authRequired`）。验证：单测或 e2e 断言两路径。
- [x] 2.3 `web/src/components/packs/PackMarketView.tsx`：透传 onRequireLogin/onOpenChat（谦面）；`facet/web/src/App.tsx` 传登录回调（rd=当前 URL）。验证：谦面匿名点订阅翻出引导行、去登录带 rd。

## 3. 部署节文案（五语 i18n）

- [x] 3.1 新 i18n 键（deploySummary/keySubtitle/rhythmSubtitle/deployOutcome/authRequired/loginHint，zh-CN 主文案+四语翻译）并接入部署节三处+错误兜底。验证：check:locales 全绿；壹座/谦面弹窗渲染新文案。

## 4. 哨兵与回归

- [x] 4.1 facet-shell.spec 扩：#/packs 细页脚（ladder 缺席+备案行在）、#/ 完整页脚、弹窗底栏常驻（不滚动可见订阅+关闭）、匿名点订阅→引导行、关闭按钮关弹窗。验证：spec 全绿。
- [x] 4.2 本地回归全组：lint/typecheck/unit/check:locales/build + fast e2e（packs + facet-shell 优先）。验证：退出 0。

## 5. 上线与验证

- [x] 5.1 提交 main → 双推 → 出片（判路 fd-build-channel；org/scs001 阻断走 law-ai-official platform-images 快照线）→ relay → ccr skopeo 实证。
- [x] 5.2 fd-infra-deploy 双清单滚 tag → ArgoCD hard-refresh → 双 rollout status。
- [x] 5.3 线上复验：#/packs 细页脚+#/ 完整页脚；弹窗底栏常驻+关闭可用；匿名点订阅→引导行+登录回跳 #/packs；部署节新文案（zh+en 两语抽查）。验证：无头浏览器断言全过。
- [x] 5.4 openspec 归档（validate --specs 先行，delta 并入 facet-platform / pack-marketplace）。
