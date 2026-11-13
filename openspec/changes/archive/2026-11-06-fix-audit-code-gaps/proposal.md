# fix-audit-code-gaps

## Why

壹座 253 spec 体检 backlog 的第二组：**代码微批**。三个小而实的代码缺口（backlog P1-3、P1-5、P2 注释批），每个独立可验：

1. **值班环不唤醒 interval 任务（P1-3，体检簇 F P1 首条）**：`lib/cell-lifecycle.js:115` cronJobsDue 要求 `j.cron && type==="recurring"`——interval 型 recurring 与 one-shot 任务永远不会唤醒 suspended/on_demand cell。cron-module 已把 interval 提为 first-class，纯 interval 任务的 cell 会被静默挂起后永不再履约——这是可靠性缺陷不是措辞问题。
2. **chat-input-focus（P1-5，体检唯一 C 级 UI 项）**：spec 唯一 requirement「新会话自动聚焦输入框」现网不可达——Composer 仅 focusTick（预填卡）触发，New chat 按钮（Sidebar.tsx:697-704）与 /new 均无聚焦路径。补聚焦行为使既有 spec 为真。
3. **陈旧注释批（P2）**：cron.js:148-149（time-of-day phase 失实注释）、cron.js:539（insertTask persona-only 过时注释）、scripts/design-lint.mjs 头注 "Five rules" 实为六条、server/blueprint-judge.js:169 陈旧注释。

## What Changes

- `lib/cell-lifecycle.js` cronJobsDue 扩展：interval recurring 任务按 lastRun+周期与 one-shot 按 nextRun 判到期（复用 cron-decisions 同口径），使 duty-ring 能唤醒纯 interval 任务的 cell。
- web 前端：New chat 按钮与 /new 命令路径触发输入框聚焦（复用既有 focusTick 缝）。
- 四处陈旧注释修正（零语义变化）。
- spec delta：cell-gateway 值班环场景补「interval 任务同参与唤醒」；cell-lifecycle 唤醒语义同步。

## Capabilities

### Modified Capabilities

- `cell-gateway`：值班环唤醒覆盖 interval 任务。
- `cell-lifecycle`：cronJobsDue 判定语义扩展。
