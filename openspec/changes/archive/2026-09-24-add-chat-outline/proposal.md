## Why

Long conversations are hard to navigate once activity groups collapse (chat-activity-collapse) and turns accumulate: the only way to find an earlier exchange is manual scrolling. Both the web chat UI and the mini-program client need an in-conversation outline — the floating quick-jump rail popularized by DeepSeek — so users can see every question they asked and jump straight to it.

## What Changes

- Add a floating conversation outline on the right edge of the chat transcript, on both the web chat UI and the mini-program chat page.
- Outline entries are the session's user turns: first line of each user prompt, truncated.
- The outline has two states:
  - **Collapsed (default)**: a small edge control on the right margin (the "—" affordance in the reference UI).
  - **Expanded**: a floating card listing the user-turn entries.
- Platform-native expansion triggers: web expands on hover (of the edge control or the card) and shows a per-entry detail (full prompt text) on entry hover; the mini-program has no hover, so tap toggles collapsed/expanded and tapping an entry jumps directly.
- Activating an entry scrolls the transcript to that turn (smooth), briefly highlights it, and releases stick-to-bottom/auto-scroll so streaming deltas do not yank the user back to the end.
- The outline appears only when the conversation has at least 3 user turns; shorter conversations show nothing.
- The collapsed/expanded choice persists per surface for the session (collapsing stays collapsed while scrolling).

Non-goals (v1):
- Current-position highlight (scroll-spy) — feasible on web, not reliably on the mini-program; deferred.
- Assistant-turn entries, timestamps, or outline editing/renaming.
- Any server-side changes: the outline is derived entirely from the client chat store.

## Capabilities

### New Capabilities
- `chat-outline-navigation`: in-conversation user-turn outline with collapsed/expanded states, platform-appropriate activation (hover on web, tap on mini-program), jump-to-turn scrolling, and auto-scroll release. Applies to both the web chat UI and the mini-program client.

### Modified Capabilities

(none — chat-activity-collapse, chat-streaming, and miniprogram-client requirements are untouched; the outline is additive UI)

## Impact

- `web/src/components/Chat.tsx` — per-turn anchor ids (`turn-<id>`), jump + stick-to-bottom release, outline rail component.
- `web/src/pages/ChatPage.tsx` (or Chat.tsx) — outline visibility threshold and collapsed-state persistence.
- `miniapp/src/pages/chat/index.tsx` — outline rail over the existing `ScrollView`; jump via the existing per-turn `id={t.id}` anchors (`scrollIntoView`); interplay with the `scrollAnchor` stick-to-bottom flag.
- `miniapp/src/app.css` — collapsed edge control, expanded card, entry highlight styles.
- No shared-core, server, or gateway changes.
