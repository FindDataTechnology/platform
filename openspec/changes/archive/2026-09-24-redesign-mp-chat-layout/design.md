# Design: redesign-mp-chat-layout

## Context

The mini-program chat page (`miniapp/src/pages/chat/index.tsx`, ~350 lines)
renders connection banner → picker row (3 native `Picker` chips + 3 text
links + ⚙) → transcript → attachments row → two-row composer. Styling is
plain CSS in `app.css` under Taro `designWidth: 750`. The web client already
establishes the target semantics: card composer with inline controls
(`web/src/components/Composer.tsx`), welcome with prefill-only suggested
prompts (`ChatWelcome.tsx`), honest regeneration = re-send last user prompt
(`Chat.tsx`). The recent `add-collapsed-activity-group` change already
aligned turn-content rendering across surfaces — this change touches only the
page shell and turn-level actions, not block rendering.

## Goals / Non-Goals

**Goals:**

- One visual language with Claude/ChatGPT mobile: three-zone header, card
  composer, centered welcome with suggested prompts.
- Reuse web semantics verbatim (prefill-not-send, honest regenerate,
  streaming guard) so behavior stays cross-surface consistent.
- Keep the change inside `miniapp/` — zero core/web/server edits.

**Non-Goals:**

- Drawer history, user-message edit/long-press, dark mode, i18n for the MP
  (hardcoded zh-CN strings remain the MP convention).
- Changing block rendering, activity groups, keyboard-lift mechanics, login
  flow, or any WS/REST contract.

## Decisions

**D1 — Half-screen panel is a custom component, not a native control.**
WeChat offers no half-screen sheet with sections (`wx.showActionSheet` is
≤6 unsectioned text rows, no disabled state). New
`components/SelectionPanel.tsx`: fixed-position mask + slide-up panel View
with 智能体 / 模型 / (模式) sections, check-mark on the current choice.
Slide-in via a CSS translate transition; degrade silently to no animation.
*Alternative*: keep three native `Picker`s (cheaper, but is exactly the
toolbar look this change removes; also rejected by user decision).

**D2 — Panel applies on tap and stays open; mask/close dismisses.** The panel
unifies 2–3 dimensions (agent, model, preset); closing after each pick would
force reopening to set the other dimension. Each tap sends the existing
`set_agent` / `set_model` / `set_preset` message immediately (same as today's
`onChange`), the header chip updates live, and the user closes when done.
The combined chip is disabled while streaming or `pendingConfig` is set —
same guard surface as the old chips, so the "reject while streaming" contract
keeps its current enforcement point.

**D3 — Composer card wraps input + chips + controls in one View.** Structure
mirrors the web composer: card → attachments row (chips, when any) →
`Textarea` (existing `autoHeight`/`adjustPosition=false`/`onKeyboardHeightChange`
behavior unchanged) → controls row (`📎` left, circular send right). Send is a
44px-ish round View with ↑; the same slot renders ■ stop while streaming
(`stopStreaming()`), disabled styling while `pendingConfig`. Emoji/text glyphs
stay (the client already uses 📎; an icon font is not worth a dependency for
a two-page client). Bottom padding becomes
`calc(env(safe-area-inset-bottom) + 24px)` (WeChat supports `env()` in page
CSS; the fixed 24px floor covers older baselines). When `kbHeight > 0` the
keyboard pad replaces the safe-area pad — the keyboard already covers the
inset.

**D4 — Welcome cards prefill; texts are copied literals.** The four zh-CN
suggested prompts are copied from `web/src/locales/zh-CN/common.json`
(`chat.welcome.suggestedPrompts`) into an MP constant — no i18n runtime for
the MP (existing convention: hardcoded Chinese). 2×2 flex-wrap grid. Tap →
`setDraft(text)` + focus the textarea; never auto-send. A 查看历史 › link
under the grid navigates to the sessions page (secondary affordance; the
header keeps its own history entry).

**D5 — Reply actions live in TurnView, wired from the page.** `TurnView`
assistant branch gains an action row after the blocks: 复制 (visible whenever
`!turn.streaming`; concatenates the turn's text blocks, `Taro.setClipboardData`
+ toast) and 重新生成 (only when the page passes `onRegenerate`, i.e. the
turn is the last assistant turn, nothing is streaming, and a preceding user
turn exists — the page computes this exactly like web `Chat.tsx`, then sends
`{type:"prompt", text: lastUserText}`). Passing callbacks as props keeps
TurnView free of "am I last" knowledge and matches the web split
(`AssistantTurn` receives `onRegenerate` from `Chat`).

**D6 — Server-settings row moves verbatim to the sessions page.** Same JSX +
`setBaseUrl` / `reconnectNow` logic, rendered at the list bottom. The WS
runtime is a module singleton and the chat page stays alive under
`navigateTo`, so a reconnect triggered from the history page updates the chat
page through the store as before.

## Risks / Trade-offs

- [Panel opens over a raised keyboard] → dismiss the keyboard
  (`Taro.hideKeyboard`) when the panel opens; the panel owns the screen.
- [Android back gesture closes the page, not the panel] → WeChat offers no
  reliable back-intercept; mask tap + close button remain the dismiss paths.
  Accepted trade-off.
- [`env(safe-area-inset-bottom)` unsupported on very old baselines] → the
  `calc()` falls back to the literal 24px floor; no double-padding risk.
- [Copy of a long turn on low-end devices] → `setClipboardData` handles
  arbitrarily long strings; toast text stays fixed-length. No truncation.
- [Regenerate doubles a prompt that failed mid-upload historically] →
  regenerate re-sends the *user text* only; attachment refs were already
  expanded into that text at send time, so re-sending is faithful.

## Migration Plan

Client-only change; no API, protocol, or data migration. Ships with the next
MP upload; rollback is a revert of the commit. The sessions-page settings
entry and the header change land together, so there is no window where server
settings are unreachable.
