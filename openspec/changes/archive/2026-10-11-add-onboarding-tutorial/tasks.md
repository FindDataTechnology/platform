# Tasks: add-onboarding-tutorial

## 1. 内容模块

- [x] 1.1 `web/src/lib/packGuides.ts`：六包指南（steps×3）+ 首四包提示卡（prompts×4），正文对照各包真实流程撰写；typecheck 绿
- [x] 1.2 聚焦通用四卡 + 引导/帮助/空态 UI 壳文案进五语言 locale（zh 定稿→四语言同步），`check:locales` 全绿

## 2. 首跑引导

- [x] 2.1 `OnboardingTour.tsx`：三步 coach-mark（testid 锚定+高亮框、视口 clamp、小屏居中退化）、跳过/下一步/Escape、localStorage 持久化；挂载 ChatPage 欢迎态
- [x] 2.2 帮助中心「重看引导」按钮清键重挂引导

## 3. 帮助中心三 tab

- [x] 3.1 `HelpDialog` 三 tab（快速上手=三步图文+词汇表+重看引导；场景教程=packGuides 列表；命令与快捷键=既有四段原样并入）；既有 testid 保留

## 4. 上下文提示 + 详情指南卡

- [x] 4.1 `ChatWelcome` 提示卡分派（packId 查表→聚焦通用→默认），切换专家即时刷新；默认四卡行为不变
- [x] 4.2 `PackMarketView` 详情页指南卡（命中渲染/未命中零变化）

## 5. 空态微教程 + 手册

- [x] 5.1 资料库/成果/自动化空态文案改写（locale，教下一步）
- [x] 5.2 `docs/user-manual.zh-CN.md` 站外手册（命名与产品一致，九节）

## 6. e2e 与回归

- [x] 6.1 新增 onboarding spec（首跑三步/跳过持久化/Escape/重看/帮助三tab/详情指南卡命中与未命中）；chat-welcome 用例迁移提示分派断言；`check:locales`/lint/typecheck/build 绿
- [x] 6.2 受影响 spec 本地定向全绿；推送 scs001 CI 全绿

## 7. 上线

- [x] 7.1 标准发布线出片→relay 实证→GitOps bump→ArgoCD 双滚→in-pod 标记实证 + 公网冒烟
