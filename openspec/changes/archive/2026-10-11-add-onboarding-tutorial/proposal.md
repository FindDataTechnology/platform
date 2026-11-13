# Proposal: add-onboarding-tutorial

## Why

R1（simplify-ia-non-technical）把语言说对了，但目标用户（无技术背景的文本/数据处理人员）从"看得懂"到"会照做"还差一层引导：新用户落在一张空白欢迎页上，四张通用提示卡与所选专家无关，行业方案装上后没有任何"三步走"教法，帮助中心只有命令速查。R2 用产品内引导补齐这一层，并交付第一份站外《壹座使用手册》。

## What Changes

- **首跑三步引导**：新用户首次到达对话欢迎页时，按 选专家 → 说需求 → 看成果 三步点亮对应界面区域；可跳过、可从帮助中心重看；完成/跳过状态按浏览器持久化。
- **上下文感知推荐提示**：欢迎页 4 张提示卡跟随当前选中专家——内置/默认专家保持现有通用四卡；选中行业方案专家时展示该包领域的四张提示卡（客户端内容模块按 packId 键控）；选中自建专家时展示聚焦模式通用提示。点击行为不变（预填不发送）。
- **帮助中心三 tab**：帮助弹窗重组为 快速上手（三步走图文 + 「重看引导」按钮 + 新命名词汇表）/ 场景教程（pack 指南列表）/ 命令与快捷键（现有命令、技能、快捷键、概念全部并入）。
- **行业方案指南卡**：市场详情页对客户端内容模块中存在指南的包渲染「使用指南」卡（三步走）；无内容的包不渲染该卡。首发覆盖六个包：法律-合同、法律-案件、数据-股票、数据-中国经济、文档工坊、数据研究·生态版。指南正文为 zh 内容模块（与包人格同为内容而非 UI 壳），UI 标签走 i18n；创作者自带教程留 R4（随包分发需 manifest 增字段，本 change 不动 schema）。
- **空状态微教程**：资料库 / 成果 / 自动化空态改写为"教下一步"文案（这些空态未被 spec 钉死文案，纯 locale 改动）。
- **《壹座使用手册》**：`docs/user-manual.zh-CN.md`，面向运营可转发的站外手册——五导航导览、对话怎么用、资料库/成果/智能体/自动化分章、设置速览、常见问题。

## Capabilities

### New Capabilities

- `onboarding-guidance`: 首跑三步引导（跳过/持久化/重看入口）、帮助中心三 tab 结构、市场详情页的包指南卡、场景教程列表。

### Modified Capabilities

- `chat-welcome-state`: 4 张提示卡的数量与点击预填行为不变；卡片内容来源改为跟随当前专家——行业方案专家展示 packId 键控的领域提示集，自建专家展示聚焦通用集，其余保持默认集。
- `pack-marketplace`: 市场详情页在客户端内容模块存在该 packId 指南时渲染「使用指南」卡；不存在时详情页保持原样。

## Impact

- `web/src/lib/packGuides.ts`（新）— packId → {指南三步, 提示卡×4} 内容模块（zh）
- `web/src/components/OnboardingTour.tsx`（新）— 三步引导组件（localStorage 持久化，testid 锚定）
- `web/src/components/HelpDialog.tsx` — 三 tab 重组
- `web/src/components/ChatWelcome.tsx` — 提示卡来源按当前专家分派
- `web/src/components/packs/PackMarketView.tsx` — 详情页指南卡
- `web/src/locales/*/common.json` — 引导/帮助/空态文案（五语言，UI 壳）
- `docs/user-manual.zh-CN.md`（新）— 站外手册
- `e2e/` — 新增 onboarding spec；chat-welcome 相关用例迁移
- 零后端、零 manifest schema、零 WS 契约改动
