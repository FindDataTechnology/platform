## Context

Both clients render the transcript from the shared core's chat store (`turns`), and both already implement stick-to-bottom auto-scroll that must be released on jump: web in `Chat.tsx` (`stickToBottomRef` re-armed by a scroll listener when within ~40px of the bottom), mini-program in `pages/chat/index.tsx` (`scrollAnchor` state driving `ScrollView scrollIntoView="msg-bottom"`). The mini-program already assigns every turn wrap a DOM id (`id={t.id}`, chat/index.tsx:333), so `ScrollView.scrollIntoView` can target any turn directly. The web turn list (also `Chat.tsx`) has no per-turn ids yet — `id={`turn-${t.id}`}` on the UserTurn/AssistantTurn wrappers is the only missing primitive. The reference interaction is DeepSeek's floating right-edge outline: collapsed "—" edge control, hover to expand (desktop), entries are user prompts.

## Goals / Non-Goals

**Goals:**
- One interaction model translated per-platform: hover (web) vs tap (MP) for expand/collapse; hover-detail (web) vs jump-reading (MP) for entry detail.
- Zero protocol/server changes — the outline derives from `turns` already in the store.
- Jump semantics that cooperate with streaming auto-scroll on both surfaces.

**Non-Goals:**
- Scroll-spy / current-position highlight (MP cannot measure turn positions; deferred, see Open Questions).
- Outline entries for assistant turns, timestamps, or hit-targeting.
- Persisting collapsed/expanded across sessions or to the server (session-lifetime UI state only).

## Decisions

### D1: One derived list, computed client-side from `turns`
Entries = `turns.filter(t => t.role === "user")`, label = first line of `t.text` truncated (~16 chars MP / ~24 web, CSS `text-overflow: ellipsis` does the clipping so the exact count is styling, not contract). No store changes, no memo hazards beyond a `useMemo` on `turns`.
*Alternative*: reuse the chat-history SQLite titles — rejected: those are per-session titles for the sidebar, not per-turn anchors, and REST round-trips would make the outline stale during streaming.

### D2: Web expansion via hover with a shared hover-bridge
CSS-only `:hover` on the edge control loses the hover when moving the pointer across the gap to the card. The control and card are siblings in one hover container (`onMouseEnter`/`onMouseLeave` on the wrapper), so the gap is covered. Per-entry detail = the entry grows to show the full prompt (max ~4 lines, `line-clamp`) rather than a floating tooltip — a tooltip would overlap the transcript and fight the jump click.
*Alternative*: tooltip popover — rejected: two stacked hover surfaces (card + popover) is fragile on the right edge.

### D3: MP expansion via tap toggle; entry tap jumps immediately
MP has no hover; a two-level interaction (tap to preview, tap again to jump) doubles taps for the common case. Tap entry = jump + auto-collapse the card (keeps the transcript unobstructed); the "—" affordance collapses without jumping.

### D4: Jump implementation per surface
- Web: `document.getElementById(`turn-${t.id}`)?.scrollIntoView({ behavior: "smooth" })` inside the scroll container; set `stickToBottomRef.current = false` before scrolling. The existing scroll listener re-arms stickiness when the user reaches the bottom again — no new machinery.
- MP: set state `{ jumpTarget: t.id }` and render `scrollIntoView={jumpTarget ?? (scrollAnchor ? "msg-bottom" : "")}` — the existing prop, just re-pointed; clear `jumpTarget` after the scroll settles (one render or short timeout) so subsequent turns re-anchor cleanly. `scrollAnchor` stays false until the user returns to the bottom (existing `onScroll`-based re-arm logic is extended the same way web does it if not already present).
- Highlight: a CSS class on the target turn wrap for ~1.2s (animation), both surfaces.

### D5: Placement and overlap
The outline floats over the transcript's right edge, above the composer, `pointer-events: none` on the wrapper except the control/card themselves so it never blocks scrolling. Threshold: render only when `userTurns.length >= 3` (spec-locked).

## Risks / Trade-offs

- [MP `scrollIntoView` with `scrollWithAnimation` can miss when content height changes mid-scroll during streaming] → clear `jumpTarget` after settle; worst case the user re-taps (no data corruption possible).
- [Outline overlaps transcript content on narrow screens] → collapsed edge control is ~28px wide; expanded card caps width at ~40% on MP, and auto-collapses on jump.
- [Web hover container intercepts transcript clicks at the right edge] → hover bridge wrapper only wraps control+card, never the transcript; card background opaque but narrow.
- [Long sessions (100+ user turns) make the expanded card overflow] → card gets its own vertical scroll (`overflow-y: auto`, max-height = transcript height minus margins) on both surfaces.

## Migration Plan

Purely additive client UI; ship behind no flag. Rollback = revert the client commits; no data or protocol to unwind.

## Open Questions

- Exact entry-truncation length and card styling (aesthetic tuning during implementation).
- Whether MP's scroll listener can cheaply approximate "returned to bottom" to re-arm `scrollAnchor` — if not, MP keeps its current manual re-arm behavior and only the jump target clears (behavior already covered by the spec's "resumes when user returns to bottom" via existing mechanisms).
