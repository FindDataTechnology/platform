# Proposal: perf-session-open

## Why

Opening a historical conversation from the sidebar or the welcome page takes many seconds on long sessions, and the click itself gives zero feedback. Three mechanisms stack: the switch is pessimistic (the view only changes when `session_loaded` arrives — until then the OLD transcript stays on screen, so the click looks dead); every switch refetches the full message body with no client cache (revisiting a session pays the full cost again); and the transcript mounts unvirtualized (`turns.map` over every turn, each running Markdown/chart rendering), so mount cost grows with session length. On the shared deployment the payload is also broadcast to every connected browser, multiplying it.

## What Changes

- **Optimistic switch with a pending state**: clicking a session immediately switches the view to the target session with a skeleton/transition state (URL already leads today); a `session_loaded` for a superseded request is ignored (request-id or id-match guard client-side). The old-content limbo and the dead-click feel are gone — feedback is instant even when the payload is slow.
- **Client-side session cache**: turns of visited sessions are memoized in the store; re-entering a cached session renders instantly and the full refetch becomes a background revalidate. Cache entries invalidate on events for that session (turn completion, rename, delete).
- **Render windowing**: only the last N turns mount initially, with a "load earlier" affordance at the top (virtualization-lite — no new dependency; the full Markdown mount of a several-hundred-turn session is what makes even a cached open janky).
- **File feedback**: the preview drawer's fetch-backed renderers and the download actions get a visible busy state (the drawer already has a text-kind `Loading`; image/pdf/download-only kinds get the same affordance) so large files show a transition instead of nothing.

Non-goals: server-side payload slimming (metadata-first or paginated `session_loaded` — the REST route already exists if needed; deferred until measured); targeted WS delivery (owned by add-session-ownership — this change benefits from it but does not require it); transcript virtualization proper (windowing first, react-virtuoso only if measured necessary); the streaming-restart hazard on navigation (rides the tenancy work).

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `web-chat-ui`: session open becomes optimistic with a pending state; visited-session turns are cached with event-driven invalidation; transcript rendering windows to the last N turns; preview/download affordances gain busy states.

## Impact

- **Code**: `packages/core/src/store/chat-store.ts` (pending state, cache, stale-load guard), `web/src/components/Chat.tsx` + `ChatWelcome.tsx` click paths (already store-mediated — no handler changes expected), `web/src/components/Chat.tsx` render windowing, `web/src/components/preview/PreviewDrawer.tsx` busy states, i18n strings (skeleton/load-earlier labels).
- **Depends on**: nothing hard; pairs with add-session-ownership (its per-viewer delivery keeps the cache from being invalidated by other users' traffic — deploy together for the full effect, independently otherwise).
- **No changes**: server WS protocol shapes (no new message types), dsh runtime, REST API.
- **Testing**: e2e for optimistic switch + stale-load guard; store unit tests for cache invalidation; existing transcript tests keep passing with windowing (they target the tail turns).
