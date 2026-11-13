## Why

产品里原本有五套手搓页签，各自 `role="tablist"` + `border-b-2` 活动态，**都没有键盘契约**：方向键不换页、Home/End 不跳首尾、没有 roving tabindex。`web-design-system` 早就写明页签该走原语（"既有三套手搓 tabs 的迁移由批②③承接"），迁移却停在中途——

`polish-material-market-tabs` 与 `unify-line-board-tabs` 把其中最显眼的两处收编了（`/agents` 五页签、`/boards/:line` 页签条），`ExtensionsPage` 也随之收编（它渲染在 `/agents` 里，不修就是同页两套语言）。剩下四处仍在手搓：

| 位置 | 现状 |
|---|---|
| `components/HelpDialog.tsx:84,94` | 帮助弹窗的章节页签 |
| `components/settings/StatusSection.tsx:32,47` | 运行状态内页页签 |
| `components/settings/PairingSection.tsx:42,57` | 配对与绑定内页页签（小程序/桌面/机器） |
| `pages/MemoryPage.tsx:409` | 永忆视图切换 |

四处共同的问题不是"长得不一样"，而是**用键盘走不动**：它们对只有键盘的用户等于禁用。而 `DESIGN.md:356` 也明令 `border-b-2` 那类彩色侧边/下边指示不属于这套设计语言（design-lint 只查左右不查上下，所以它们一直是绿的）。

## What Changes

- 四处页签条一律改用 foundation `Tabs`：`role=tablist/tab`、`aria-selected`、方向键/Home/End、roving tabindex 由原语统一提供。
- 四处活动态不再用 `border-b-2`，视觉跟随原语的选中样式，与 `/agents`、`/boards`、`ExtensionsPage` 一致。
- 公开的 testid 契约逐个保留（`/agents` 那批已验证过做法：用 `itemProps` 注入 `data-testid`）。
- 既有 e2e 的断言从"按 `role=button` 找页签 / 比对 `border-primary` 类"改为**按 `role=tab` 找 + 断言 `aria-selected`**——断言对位产品真实语义，比原来更严。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `web-design-system`: 把「Tabs 键盘与角色契约」从"只锁定原语行为、迁移另算"推进为"**产品内每一处页签条 SHALL 由该原语渲染**"，并把活动态的判据钉在 `aria-selected` 上而不是某个类名。

## Impact

- `web/src/components/HelpDialog.tsx`、`web/src/components/settings/StatusSection.tsx`、`web/src/components/settings/PairingSection.tsx`、`web/src/pages/MemoryPage.tsx`
- 相关 e2e：`e2e/help.spec.js`（若有）、`e2e/memory*.spec.js`、`e2e/settings-modal.spec.js`、`e2e/trace*.spec.js` 等按需对齐 role/selec 断言
- **不动**：任何页签的 slug/标签/排序/业务行为；`ExtensionsPage`、`/agents`、`/boards` 已在别处收编，不回改
