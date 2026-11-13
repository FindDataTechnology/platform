# Tasks: add-collapsed-activity-group

## 1. Core store (shared)

- [x] 1.1 Add `groupTurnBlocks(blocks)` pure helper to `@platform/core` (maximal runs of thinking/tool/skill/command; text breaks a run) with unit-style verification via a small node script or existing test runner covering: typical turn, interleaved turn, empty turn
- [x] 1.2 Add per-turn `groupState: Record<number, boolean>` and `toggleGroup(turnId, startIndex)` action to the chat store; verify a manual store-driven render round-trip toggles only the targeted group
- [x] 1.3 Record `activityStartedAt` (first non-text block push) and `activityEndedAt` (first text block or turn close) on assistant turns; verify a streamed turn ends with both timestamps set and a history-loaded turn has neither
- [x] 1.4 On tool result with `isError`, open the containing group in `groupState`; on history hydration, groups containing errored blocks default expanded; verify by replaying a session with an errored tool call
- [x] 1.5 Replace `toggleAllThinking` with `toggleAllGroups` (any-closed → open all, else close all); keep inner block `open` flags untouched; verify the Ctrl/Cmd+O hook still compiles against the renamed action
- [x] 1.6 Delete the `autoOpen` flag and the fold-on-text-arrival branch in the turn-done path; verify thinking blocks still carry `open: true` by default and nothing streams visibly open

## 2. Web surface

- [x] 2.1 Add `ActivityGroup` component (header: chevron, spinner/status while streaming, plain-language summary when done, error styling when containing an errored block; body: existing block switch) and wire it into `AssistantTurn` via `groupTurnBlocks`; verify `data-testid="activity-group"` with `data-open` renders and text blocks stay outside
- [x] 2.2 Add i18n keys (`turn.activityRunning`, `turn.activityStep`, `turn.activityDone`, `turn.activityErrored`) to all five locales (`en`, `zh-CN`, `ja`, `es`, `fr`); verify each locale renders its own header text
- [x] 2.3 Update the Ctrl/Cmd+O hook to the renamed toggle-all action; verify manually that all groups toggle together and inner block states don't change

## 3. Mini-program surface

- [x] 3.1 Wrap consecutive non-text blocks in a group View in `TurnView` using the same helper (header row with live status/final summary, hardcoded Chinese strings, error styling for errored groups) and add chat page styles; verify in WeChat devtools that a multi-tool turn renders one collapsed group and text stays visible
- [x] 3.2 Verify on the mini-program that toggling a group opens/closes it, an errored tool auto-expands its group, and history replay keeps error groups expanded

## 4. Tests and verification

- [x] 4.1 Update web e2e tests that assert streaming thinking visible-open or top-level tool blocks: nest expectations under `activity-group`, assert default `data-open="false"`, assert text blocks outside; run the web e2e suite and compare failures against the known flake baseline
- [x] 4.2 Add an e2e case for the error path: a turn with a failing tool ends with its group `data-open="true"` without user interaction
- [x] 4.3 Cross-surface manual pass: same session rendered on web and mini-program shows consistent grouping, collapsed defaults, and error expansion; record results in the change notes

## Verification Log (2026-09-24)

- **Store (node harness on bundled core):** grouping (typical / interleaved / error-breaks-run / command-outside), toggleGroup + toggleAllGroups semantics (override wins over derived error-open; inner block states untouched), live error auto-expand, history replay error-open with no clock, legacy text-only turn = 0 groups.
- **Web e2e (fast project):** thinking-blocks.spec.js rewritten for groups — 12/12 pass, including default-collapsed, no visible streaming thinking, expand-reveals-open-thinking, header without tool names, error auto-expand live + replayed, Ctrl+O on one/many groups, shortcut leaves inner blocks alone. plan-progress / plan-smoke / composer-stop patched to expand groups before inner assertions. Full fast suite: 233 passed; 3 failures investigated — two are known flakes (pass in isolation, different victims per run), one (sso-user-bindings) fails identically on a stashed clean tree, pre-existing.
- **Mini-program (wechatide devtools, stub WS server replaying a scripted run):** streaming state renders ONE collapsed group with live header "正在执行第 1 步…"; errored run auto-expands with error styling and plain header "执行中遇到问题 · 已执行 2 步"; completed clean run shows timed header "已思考 25 秒 · 执行了 1 步"; tap toggles collapse/expand; answer text always outside the group. (A concurrent-run tangle observed mid-session was a stub artifact — the stub interleaved two scripted runs on one socket; the real server serializes runs, and the store still produced consistent groups.)
- **Mid-apply refinement (D1a):** command blocks were moved out of grouping after the `/model` e2e caught its echo — the command's whole feedback — being hidden; spec scenario "Command echo stays visible" added.
