## Context

The React chat surface lives in `web/src/App.tsx` (grid shell) with `<Chat>` (message log) and `<Composer>` (input) stacked in the right column. `Chat.tsx` uses `flex-1 overflow-y-auto`, which normally scrolls internally, but its parents don't cap the child's intrinsic minimum height. In CSS grid+flex, a scroller's implicit `min-height: auto` expands to its content, so the whole `<main>` column grows past `100vh` and the browser scrollbar takes over — pushing the composer off-screen during long streams.

The vanilla frontend at `public/index.html` doesn't have this problem because it uses a simpler flex column with an explicit `height: 100vh` chain. The React shell was migrated in `openspec/changes/archive/2026-07-20-redesign-chat-ui-react-shadcn/` without preserving that constraint.

## Goals / Non-Goals

**Goals:**
- Chat page always fits the viewport (`100dvh`), sidebar + log + composer never overflow the window.
- Only the message log scrolls; composer stays pinned at the bottom.
- Empty-state text no longer pushes the composer down on a fresh chat.
- Zero behavioral change to WebSocket/streaming/commands/tool rendering.

**Non-Goals:**
- Redesigning the empty state, sidebar, or composer.
- Porting Documents/OpenConnector/Dashboard/LiteLLM views (still vanilla; separate migrations).
- Any mobile-specific chrome (keyboard-avoidance, safe-area insets) beyond `dvh` for the outer height.
- Changing the WebSocket protocol or any REST endpoint.

## Decisions

### 1. Use `h-dvh` on the outer grid, `min-h-0` on the scroll ancestors

Change `App.tsx`:
- `grid h-screen grid-cols-[240px_1fr]` → `grid h-dvh grid-cols-[240px_1fr] overflow-hidden`.
- `<main class="flex min-w-0 flex-col">` → `<main class="flex min-h-0 min-w-0 flex-col">`.

Change `Chat.tsx`:
- `flex-1 overflow-y-auto px-4 py-6` → `min-h-0 flex-1 overflow-y-auto px-4 py-6`.

Why `dvh` over `vh`: mobile browsers subtract the URL bar from `100dvh` dynamically, so the composer stays visible when the address bar collapses/expands. `vh` freezes on the largest viewport and leaves the composer clipped below the fold. Modern browser support is universal (Safari 15.4+, Chrome/Edge/Firefox current). Fallback: `h-screen` remains identical on desktop; if we ever need to support older Safari, add `h-screen dvh:h-dvh` — not worth the complexity today.

Why `min-h-0` (and `min-w-0`) rather than fixing heights numerically: the `min-height: auto` default is exactly what makes flex/grid children refuse to shrink below their content. Setting it to `0` on the ancestor chain lets `overflow-y-auto` engage. This is the idiomatic Tailwind fix and doesn't hardcode any pixel values.

Alternative considered: absolute-position the composer at `bottom-0` and give the log `absolute inset-0 bottom-[composerHeight]`. Rejected — requires measuring the composer height (autogrows up to 200 px) and threading it through, when the flex+min-h-0 fix is one line per file.

### 2. Move the empty state inside the flex column

Change `Chat.tsx` to render the empty-state hint as a centered flex child (e.g. wrap the inner `mx-auto` block in a container that becomes `flex items-center justify-center` when `turns.length === 0`), instead of the current `mt-[30vh]` push. This keeps the composer at the viewport bottom on a fresh chat regardless of whether an empty-state is shown.

### 3. No changes to Composer

The composer sits after `<Chat>` in the flex column; once `<Chat>` stops expanding, the composer naturally pins to the bottom. Its own autogrow (up to 200 px) doesn't push through because the flex column has `min-h-0`, so the log gives up space to the composer, not the other way around.

## Risks / Trade-offs

- **[Risk]** `h-dvh` on very old Safari (< 15.4) falls back to `auto` → Mitigation: negligible user share; if a regression appears, use `h-screen dvh:h-dvh` for a graceful fallback.
- **[Risk]** Sticking-to-bottom behavior in `Chat.tsx` uses `scrollHeight`/`scrollTop`; adding `min-h-0` doesn't change those semantics, but a very short viewport could hide the last user turn behind the composer if the log's `py-6` bottom padding is too small → Mitigation: existing padding is fine; add a Playwright assertion that the last turn is visible after send.
- **[Trade-off]** The empty-state hint moves from ~30 vh below the top to vertically centered. Minor cosmetic change; matches the intent of "welcome message" more faithfully anyway.
