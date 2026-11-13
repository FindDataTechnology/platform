## Why

`restructure-yizuo-ia` 上线后（`sha-d7c89b2`）用户实测三条反馈，两条是真 bug，一条是观感：

1. **中文比英文难看**。家族头（知识/构建/运行/接入）与设置分组头（常规/能力/管理）用的是拉丁小标签的写法：`11px / 10px + uppercase + tracking-wide`。拉丁大写本身就是"小号标签"的视觉语言，字距散开反而像刻意排版；同样的属性落在汉字上，11px 汉字笔画糊成一团、字距被拉散，读作"这行字坏了"。项目切换器同理（`text-[11px]`）。
2. **折叠/展开点击有时不生效**。`collapsed = !isActiveFamily && …` 让"当前路由所在的家族"永不可折叠：点它有状态变化、没有视觉变化。全局"全部折叠"更矛盾——它把所有家族写进折叠集，渲染却强展当前家族，于是图标已变「展开全部」而屏幕上还有一族开着。
3. **首启动引导卡吐原始 key**：`onboarding.tour.steponboarding.tour.step1.title`（`OnboardingTour.tsx:240` 把 key 拼成了 `step` + 完整 key + `.title`）。与 IA 无关，但它是新用户看到的第一屏。

## What Changes

- **按语种分档的微标签排版**：新增一套 `micro-label` 语义（挂在 `<html lang>` 上，i18n 已在维护它），拉丁语种保持 `11px / 0.02em / uppercase`，中日文用 `12px / 0 / none`。家族头、设置分组头、项目切换器、构建家族快捷行统一走它，消除逐处手调字号。
- **折叠语义改为「进入时展开，点击即生效」**：任何家族都可折叠；路由**从别处进入**某家族时自动展开它（深链不会落在隐藏面上）；全局开关的图标只反映用户的折叠意图，不再被强展规则篡改。
- **修掉引导卡的 key 拼接**，并给该卡片补一条渲染断言（key 不得出现在可见文本里）。
- **混排标签清理**：`工具 / MCP` 这类"中文 + 斜杠 + 拉丁"在中文语境里读断，改为单语种自然的写法（中文：工具；英文：Tools / MCP；MCP 作为副标题而非主标签）。

## Capabilities

### Modified Capabilities

- `web-design-system`：新增「按语种分档的微标签排版」需求——同一语义标签在拉丁语种与中日文下取不同字号/字距/大小写，禁止对 CJK 施加 uppercase 与小字号。
- `sidebar-nav-families`：折叠语义由「当前家族强制展开」改为「进入时展开、点击即生效」，并约束全局开关的状态必须与渲染一致。

## Impact

- `web/src/styles/globals.css`（micro-label token，按 `:lang()` 分档）
- `web/src/components/Sidebar.tsx`（家族头、项目切换器、快捷行、折叠逻辑与全局开关）
- `web/src/components/settings/SettingsDialog.tsx`（分组头）
- `web/src/components/OnboardingTour.tsx`（key 拼接）
- `web/src/locales/*`（若改动标签文案）
- `e2e/layout.spec.js`、`e2e/nav-persistence.spec.js`、新增折叠语义与引导卡断言

不触碰：市场面、设置成员（那属于 `unify-material-market`）、服务端任何逻辑。
