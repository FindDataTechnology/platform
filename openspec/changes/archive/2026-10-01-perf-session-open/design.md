# Design: perf-session-open

## Context

Session open today is pessimistic end-to-end: the store replaces `turns` only on `session_loaded` (full message bodies), nothing between click and arrival gives feedback, and `Chat.tsx` mounts every turn unvirtualized. Measured live on fd-prod: multi-second opens on long writing sessions. See proposal.md for the three stacked mechanisms.

## Goals / Non-Goals

Goals: instant feedback on every session activation; instant re-entry for visited sessions; mount cost independent of session length; busy states on file retrieval. No WS protocol additions, no server changes required (though it pairs with add-session-ownership's per-viewer delivery).

Non-Goals: server payload slimming (deferred until measured after this lands); full virtualization (windowing first); streaming/partial transcript loads; MP client parity (web first; MP's file chip already has its own affordances).

## Decisions

### D1 — Optimistic switch in the store: `currentSessionId` moves immediately, `turns` defer

On activation the store sets `currentSessionId = target`, `turns = []`, `pendingSession = target`, and renders the pending placeholder. This also neutralizes the deep-link effect loop for free: it re-sends `switch_session` only when `urlSessionId !== currentSessionId`, which the optimistic set already satisfies. `session_loaded` applies only when `m.id === currentSessionId`; otherwise it updates the cache (D2) and is dropped for the view. Failure paths (`error` for the switch) clear pending and restore the previous session id.

*Alternative rejected*: keeping `currentSessionId` pessimistic and adding a separate `pendingSessionId` — the deep-link effect would re-send `switch_session` on every URL change during pending, fighting the in-flight load.

### D2 — Cache is keyed by session, filled on load, LRU-bounded, conservatively invalidated

`Map<sessionId, Turn[]>` (cap ~10, LRU evict) filled from every applied `session_loaded`. Re-entry: if cached, render cache instantly and keep a background flag until the refresh lands (the switch message is still sent; its `session_loaded` reconciles). Invalidation: delete drops the entry; a `done`/turn-completion event refreshes the entry for the session it names — pre-ownership deploys, turn events carry no session id, so the conservative rule is "a `done` received while viewing S refreshes S's entry only"; other sessions' staleness is accepted until add-session-ownership adds session ids to turn events. Rename never touches turns.

*Alternative rejected*: invalidating the whole cache on every `done` — throws away exactly the reuse this change exists for on a shared deployment.

### D3 — Windowing is a render-layer slice, never a data slice

Store keeps the complete turn list; `Chat.tsx` renders `turns.slice(-N)` (N=50 initial, +50 per load-earlier) with the affordance at the top and `scrollTop` anchoring on prepend. Because data stays complete, outline navigation, export, and existing e2e assertions on tail turns see identical inputs. Deep links that target an early turn (outline jump) expand the window to cover the target index.

*Alternative rejected*: react-virtuoso — a dependency and a scroll-model change to buy what slicing already buys at these session sizes; revisit only if measured necessary.

### D4 — One busy pattern across the drawer; downloads fetch-then-fallback

PreviewDrawer's `Loading` state (today text-kinds only) becomes the universal pending state for image/pdf/docx/external renderers. The download actions (header + DownloadOnly fallback) switch to `fetch → blob → object URL → save` with a spinner, same-origin so the auth cookie rides, falling back to a plain anchor navigation on any fetch failure — a busy download must never become a failed download.

## Risks / Trade-offs

- [Brief staleness on cached re-entry] The background refresh reconciles within one round-trip; the alternative (no cache) is the status quo this change removes.
- [Pre-ownership stale cache for background sessions] A turn completing in a non-viewed session can't be attributed until events carry session ids → accepted ceiling, explicitly resolved by deploying add-session-ownership (its spec adds the field).
- [Windowing hides early turns from glanceable scroll] Mitigated by the load-earlier affordance and outline-driven expansion; N is a constant, not config.

## Migration Plan

Single frontend deploy, no server coordination. Land after or alongside add-session-ownership for the cache-invalidation payoff; independent otherwise. Rollback = revert the web bundle.

## Open Questions

- The N of the window (50) and the LRU cap (10) — constants to tune after fd-prod measurement; changing them is a one-line constant.
