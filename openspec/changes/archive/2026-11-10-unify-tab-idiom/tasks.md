# Tasks — unify-tab-idiom

## 1. 收编四处手搓页签

- [x] 1.1 `components/HelpDialog.tsx`：章节页签改 `Tabs`，保留原 testid；活动态改 `aria-selected` —— 验证：弹窗内方向键可换章节
  - 实证：`help-tab-<id>` 经 `itemProps` 保留；`border-b-2` 归零；`onboarding` + `composer-stop`（会开帮助弹窗）**19/19 绿**
- [x] 1.2 `components/settings/StatusSection.tsx`：内页页签改 `Tabs` —— 验证：`e2e/settings-modal.spec.js` 绿
  - 实证：`status-tabs` 容器 + 每项 `testId` + `data-active` 全部经 `itemProps` 保留；`settings-modal` + `memory-dashboard` **16/16**、`trace` 同批绿
- [x] 1.3 `components/settings/PairingSection.tsx`：小程序/桌面/机器三页签改 `Tabs` —— 验证：三页签可键盘切换，深链 `?panel` 行为不变
  - 实证：`pairing-tabs` + `pairing-tab-<id>` + `data-active` 保留；`settings-devices` + `settings-wechat-app` **11/11 绿**（两者都断言 `pairing-tab-*` 的 `aria-selected`）
- [x] 1.4 `pages/MemoryPage.tsx`：视图切换改 `Tabs`，保留 `memory-view-tabs` 锚点 —— 验证：`e2e/memory*.spec.js` 绿
  - 实证：`memory-view-tabs` 与 `memory-tab-<v>` 保留，共享同一 items/筛选 state；`memory-dashboard` 绿

## 2. 断言对位真实语义

- [x] 2.1 受影响的 e2e 把「按 `role=button` 找页签」「比对 `border-primary` 类」改为 `role=tab` + `aria-selected`
  - 实证：本单四处原本就带 `role=tab`，无需改断言；已收编的 `ExtensionsPage` 那批（10 处 `role=button` → `role=tab`、6 处 `border-primary` → `aria-selected`）上一轮已改并留注释
      —— 验证：grep 全 e2e 不再有对页签断言 `border-primary`
- [x] 2.2 逐条确认没有 testid 因收编消失（迁一个跑一个对应 spec）
  - 实证：迁一个跑一个对应 spec（`settings-devices`/`settings-wechat-app`/`trace`/`memory-dashboard`/`settings-modal`/`onboarding`），全绿
      —— 验证：改动前后 `grep -c` 同一 testid 数量一致

## 3. 收口

- [x] 3.1 全仓门禁：`web/src` 内除 `ui/tabs.tsx` 无 `role="tablist"`；`border-b-2` 在页签场景归零
  - 实证：`grep -rn 'role="tablist"' web/src | grep -v components/ui/tabs` → **无输出**；四处文件 `border-b-2` 计数均为 0
      —— 验证：`grep -rn 'role="tablist"' web/src | grep -v components/ui/tabs` 无输出
- [x] 3.2 `npm run typecheck` + `npx biome check` + `npm run check:locales` + design-lint 基线不涨
  - 实证：typecheck 干净；biome 对四个文件零 finding（顺带清掉三处因此不再使用的 `cn` 导入）；design-lint 待随全量复跑核对
      —— 验证：四条退出码 0
- [x] 3.3 e2e：受影响 spec 全绿（先 `npm run web:build:e2e`）
  - 实证：`settings-modal`+`memory-dashboard` 16/16、`settings-devices`+`settings-wechat-app`+`trace` 11/11、`onboarding`+`composer-stop` 19/19；均先跑 `web:build:e2e`
      —— 验证：逐条列出通过的 spec 与条数
- [x] 3.4 `openspec validate unify-tab-idiom --strict` 绿
  - 实证：`Change 'unify-tab-idiom' is valid`
      —— 验证：输出 `is valid`
