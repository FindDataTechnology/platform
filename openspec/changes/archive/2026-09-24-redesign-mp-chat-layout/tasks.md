# Tasks: redesign-mp-chat-layout

## 1. Half-screen selection panel (component)

- [x] 1.1 Create `miniapp/src/components/SelectionPanel.tsx` (mask + slide-up panel; sections for 智能体 / 模型 / 模式; check-mark on current choice; tap emits the pick, mask/close emits dismiss; disabled styling while a switch is pending) plus panel styles in `app.css`; verify a standalone render in WeChat devtools shows the panel over a mask and tapping the mask closes it
- [x] 1.2 Wire the panel into the chat page state (open flag, current agent/model/preset from the store, `set_agent`/`set_model`/`set_preset` send on tap, `pendingConfig` guard); verify in devtools that a model tap applies immediately (chip label updates), two taps switch both agent and model in one opening, and choices are inert while `pendingConfig` is set

## 2. Header: three-zone layout

- [x] 2.1 Replace the `picker-row` with a three-zone header (history entry left, combined「智能体 · 模型」chip opening the selection panel, new-session action right); delete the separate model/agent/preset chips, the 新会话/历史 text links, and the ⚙ entry + `server-row` from the chat page; verify in devtools the header shows exactly the three affordances and the connection banner still renders above it when disconnected
- [x] 2.2 Hide the 模式 section when the session has turns (reuse the existing `turns.length === 0` condition); verify in devtools that the panel lists presets on a fresh session and omits them after the first prompt

## 3. Composer card

- [x] 3.1 Restructure the composer into one rounded card containing the textarea, attachment chips row (moved inside), and controls row (📎 left; circular ↑ send right that becomes ■ stop while streaming, disabled styling while `pendingConfig`); keep the existing `kbHeight` lift and `handleSend`/`handleStop` logic; verify in devtools: chips+input+controls in one card, send inert on empty draft, stop finalizes a streaming turn
- [x] 3.2 Replace the fixed 24px bottom pad with `calc(env(safe-area-inset-bottom) + 24px)` and let the keyboard pad supersede it while `kbHeight > 0`; verify in devtools (iPhone X-class simulator) the controls clear the home indicator, and with the keyboard up the card sits above it

## 4. Welcome with suggested prompts

- [x] 4.1 Replace the two-line welcome with a centered greeting + 2×2 suggested-prompt card grid (four zh-CN prompt texts copied from `web/src/locales/zh-CN/common.json` `chat.welcome.suggestedPrompts`) + a 查看历史 › link; verify in devtools that tapping a card fills the draft (nothing sent) and the link opens the sessions page

## 5. Reply actions (copy / regenerate)

- [x] 5.1 Add an action row to the assistant branch of `TurnView`: 复制 on every completed turn (concatenate text blocks → `Taro.setClipboardData` + toast); verify in devtools that copying a markdown-rendered turn puts its plain text on the clipboard
- [x] 5.2 Compute last-assistant + last-user-prompt in the chat page (web `Chat.tsx` logic) and pass `onRegenerate` to only that turn; regenerate sends `{type:"prompt", text: lastUserText}` and is hidden while streaming or when no user turn exists; verify in devtools that regenerate appends a new turn pair and leaves earlier turns untouched

## 6. Server settings relocation

- [x] 6.1 Add the server-address row (same input + save logic: `setBaseUrl`, toast, `reconnectNow`) to the bottom of the sessions page list; verify in devtools that saving an address from the history page reconnects and the chat page reflects the new status

## 7. Verification

- [x] 7.1 Full manual pass in WeChat devtools against the delta spec scenarios: three-zone header, panel dismiss/apply/streaming-reject, preset gating, composer card + safe area + stop, welcome prefill, copy/regenerate, settings relocation; run `pnpm --filter miniapp build:weapp` (or the repo's MP build) to confirm a clean compile, and record results in the change notes
