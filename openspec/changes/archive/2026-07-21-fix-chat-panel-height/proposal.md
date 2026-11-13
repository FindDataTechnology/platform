## Why

The React chat surface at `/chat` currently lets the message log dictate the page height: as turns accumulate, the whole `main` column grows past the viewport, the browser scrollbar takes over, and the composer scrolls off-screen instead of staying pinned to the bottom. On a fresh session the composer sits mid-page (below a tall empty state) rather than at the viewport edge. Users lose access to the input during long streams, which defeats the whole point of a chat UI.

Root cause: `App.tsx` uses `grid h-screen grid-cols-[240px_1fr]`, but the `<main>` column and the `<Chat>` scroller inside it don't set `min-h-0`. In a CSS grid/flex layout, a scrollable child inherits an intrinsic `min-height: auto` that expands to its content, so `overflow-y-auto` on `Chat.tsx` never engages.

## What Changes

- Pin the chat viewport to `100vh` (well, `100dvh` on mobile) so the sidebar, message log, and composer stay within the viewport no matter how long the transcript grows.
- Constrain the `<main>` column and the `<Chat>` scroller with `min-h-0` (and matching `min-w-0` where applicable) so `flex-1 overflow-y-auto` on the log actually scrolls internally instead of expanding the parent.
- Keep the composer as a fixed-height footer of the `<main>` column — never inside the scrolling region.
- Move the empty-state placeholder into the log's flex layout (centered via flex, not a `mt-[30vh]` push) so it stops shoving the composer down on an empty chat.

No behavioral changes to WebSocket protocol, streaming, or any other capability — this is a layout-only fix in `web/src/App.tsx` and `web/src/components/Chat.tsx`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `chat-ui-shell`: add a layout requirement stating that the chat viewport is fixed to the browser viewport, with the message log as the only scrolling region and the composer always visible.

## Impact

- Code: `web/src/App.tsx`, `web/src/components/Chat.tsx`. Possibly a small tweak to `web/src/components/Composer.tsx` if the empty-state removal affects the shared max-width container.
- Tests: existing Playwright e2e (`e2e/chat-turn.spec.js`, `e2e/chat-history.spec.js`) should keep passing; add one assertion that the composer stays within the viewport after N turns.
- No server, API, or dependency changes.
