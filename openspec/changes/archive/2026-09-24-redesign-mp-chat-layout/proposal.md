# Proposal: redesign-mp-chat-layout

## Why

The mini-program chat page works but reads as a toolbar-era UI: a picker row
crams model/agent/preset chips plus three text links into one strip, the
composer splits input and actions into two rows with a text-button send, and
the welcome state is two static lines of text. Users coming from Claude /
ChatGPT mobile (the stated reference) expect a three-zone header, a card
composer with an inline circular send button, and a welcome state with
suggested prompts. The web client already implements all of these semantics
(`Composer.tsx`, `ChatWelcome.tsx`, `UserTurn`/`AssistantTurn` actions); the
mini-program is the only surface left behind.

## What Changes

- **Three-zone header**: history entry (left), one combined「智能体 · 模型」
  chip (center/right), new-session action (right). The separate model chip,
  agent chip, preset chip, 新会话/历史 text links, and the ⚙ server-settings
  entry are removed from the header.
- **Half-screen selection panel**: tapping the combined chip opens a custom
  bottom sheet (mask + slide-up panel) that unifies agent selection, model
  selection, and — only in an empty session — preset selection. Replaces the
  three native `Picker` wheels. The streaming guard (reject switch while a
  turn streams) is unchanged.
- **Card composer**: one rounded card containing the input, attachment chips,
  and a controls row (📎 left, circular ↑ send right that becomes ■ stop while
  streaming). Adds `env(safe-area-inset-bottom)` handling (currently a fixed
  24px pad that the home-indicator overlaps on full-screen devices). The
  existing keyboard-lift behavior is preserved.
- **Welcome state with suggested prompts**: centered greeting plus 2×2
  suggested-prompt cards. Tapping a card prefills the draft (never
  auto-sends), matching the web `ChatWelcome` contract; the four zh-CN prompt
  texts are reused from the web locale bundle. A "查看历史 ›" link replaces
  the header's 历史 entry as a secondary affordance (header keeps its own).
- **Reply action row**: every completed assistant turn gains a 复制 action
  (`Taro.setClipboardData` + toast); the last assistant turn also gains
  重新生成 with the web's honest-regeneration semantics — re-send the last
  user prompt as a new appended turn (dsh has no replace-turn RPC).
- **Server settings relocation**: the dev-era server-address row moves from
  the chat header to the bottom of the sessions (history) page.

Non-goals: drawer-style history (the standalone page plus native back-swipe
suffices), user-message long-press menu / edit-and-resend, dark mode, any web
or core changes.

## Capabilities

### New Capabilities

(none — all deltas land in the existing mini-program client spec)

### Modified Capabilities

- `miniprogram-client`: the model/agent selection requirement is restated for
  the combined chip + half-screen panel surface (same list_models/list_agents
  sources, same streaming guard); new requirements for the three-zone header
  + card composer shell, the suggested-prompt welcome state, and the
  copy/regenerate reply actions.

## Impact

- `miniapp/src/pages/chat/index.tsx` — header, welcome, composer, attachment
  row, reply actions wiring.
- `miniapp/src/components/TurnView.tsx` — assistant-turn action row only
  (copy/regenerate); block rendering and activity groups untouched.
- `miniapp/src/components/` — one new half-screen panel component.
- `miniapp/src/pages/sessions/index.tsx` — bottom server-settings entry.
- `miniapp/src/app.css` — header/composer/welcome/action-row styles, safe
  area; all in the existing 750-designWidth plain-CSS idiom.
- No `@platform/core`, web, or server changes (regenerate re-uses the
  existing `prompt` message; suggested prompts are copied as literals).
