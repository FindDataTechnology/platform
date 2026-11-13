# Proposal: add-plan-progress-panel

## Why

The dsh runtime already offers the model a `todo_write` tool (composed via `dsh-base`, present in every captured `request/header`), and every call appends a `todo/write` session event carrying the whole task-list snapshot — but `server/dsh-events.js` has no case for it, so the plan is silently dropped and the web chat has no way to show what the agent is working through. During multi-step agent work the user can only infer progress from the tool-call transcript.

## What Changes

- **Server**: `server/dsh-events.js` handles `todo/write` — caches the latest snapshot per dsh session (`Map<dshSessionId, todos>`), broadcasts a new WS event `{ type: "todos", todos, counts }`. `turn/start`/`turn/end` do NOT clear it (lifecycle option C: the plan persists across turns; only a new `todo/write` replaces it wholesale). A new chat session clears it.
- **Rehydration**: the cached snapshot is pushed on WS connect (same pattern as `current_permission` in `server/ws.js`) and after `session_loaded`, so a reload or a switch-away-and-back restores the plan without SQLite. A server restart starts empty (accepted v1 limitation).
- **Protocol/store**: new server event `todos` in `packages/core/src/types/ws.ts`; `todos` state + `apply` case in the chat store; reset on `session_loaded`/`clearView` (server re-push follows).
- **UI — desktop (≥ lg)**: a right-side Progress panel next to the chat column (300px, `border-l`, same height as the header/log/composer stack, own header aligned with the session header). Header shows `Progress <completed>/<total>` and a collapse toggle; items render with status icons (pending ○, in_progress ● + spinner + accent, completed ✓ muted + strikethrough), `line-clamp-2` with tooltip; the list scrolls internally and auto-scrolls to the first in-progress item. Model-given order is preserved.
- **UI — narrow (< lg)**: the panel degrades to a collapsed one-line dock inside the composer card, above the textarea (the official dsh TodoDock form): `Progress 3/6 · 2 in progress` (zero-count segments omitted), tap to expand inline. It belongs to the pinned composer stack, so expansion pushes the message log, never the composer off-screen.
- **Empty plan**: both forms unmount entirely — no dead column, the chat column re-centers. The panel appears only once a plan exists.
- **Transcript**: a `todo_write` tool call renders as one compact line ("更新了计划（3/6）" / localized) instead of the generic collapsible block with raw JSON args.
- **PreviewDrawer coexistence**: the file-preview drawer (already `fixed right-0 z-40`) simply overlays the panel; no coordination.
- **No model-behavior change**: no persona/nudge is added (decision: display-only). Post-ship, `SELECT COUNT(*) FROM trace_events WHERE event_type='todo/write'` (14-day retention) tells us whether a follow-up nudge is warranted.

## Capabilities

### New Capabilities
- `chat-plan-progress`: the end-to-end plan surface — server capture of `todo/write`, the `todos` WS event, lifecycle (whole-list replacement, persists across turn boundaries, cleared on new session, restored on session re-entry), the ≥ lg right panel, the < lg composer dock, and the empty-plan hiding rule.

### Modified Capabilities
- `tool-use-rendering`: the "UI renders tool calls as collapsible blocks" requirement gains an exception — `todo_write` calls render as a compact one-line summary referencing the plan, not a generic block with raw JSON.
- `chat-ui-shell`: the "message log is the only vertically scrolling region" requirement is widened — the message log and the plan panel are the two permitted internal scrollers; the < lg dock expansion belongs to the pinned composer stack.

## Impact

- **Server**: `server/dsh-events.js` (new event case + ctx cache), `server/ws.js` (connect/ready sync push), `server/agent-session.js` (snapshot push after `session_loaded`, clear on new session).
- **Protocol/shared**: `packages/core/src/types/ws.ts`, `packages/core/src/store/chat-store.ts`.
- **Web**: new `PlanPanel` component (+ list/status-icon subparts), `ChatPage` two-column layout wrapper, `Composer` dock slot, `ToolBlock` special case for `todo_write`.
- **i18n**: ~8 new keys × 5 locales (en, es, fr, ja, zh-CN).
- **e2e**: new specs for broadcast→render, whole-list replace, turn-boundary persistence, new-session clear, switch-back restore, empty-hide, ToolBlock line, < lg dock.
- **No changes** to composer control placement, widths, or dsh profile composition (those belong to the separate `redesign-composer-controls` change).
