# Design: add-plan-progress-panel

## Context

The dsh runtime composes `@deepseek-ai/dsh-tool-todo` via `dsh-base` (our `platform` profile bundles it; verified against `data/app.db` — `todo_write` appears in every captured `request/header`). Each model call to `todo_write(todos)` appends a `session.event` of type `todo/write` carrying the whole-list snapshot `{ todos: [{ content, status }] }`. `server/dsh-events.js` maps the session event stream onto our frozen WS protocol but has no case for `todo/write` — it falls into `default` and is debug-logged only. The protocol (`packages/core/src/types/ws.ts`) has no plan event; the store has no plan state.

Constraints that shape the design:

- One dsh runtime multiplexes the web chat and bot chats (session routing, design D2 of the archived trace/dsh work): non-web session events go to their collector, never to the WS broadcast.
- The SDK wire exposes no RPC to read a session's standing plan — only `initialize`, `session/prompt`, `shutdown` plus our bridge's `presets/list`, `permissions/list`, `permissions/set`, `session/delete`. So rehydration must come from host-side state, not a runtime query.
- `server/ws.js` already pushes cached runtime state on connect (`current_permission` at the connection handler and in `syncReadyClient`); `server/agent-session.js` broadcasts `session_loaded`.
- The chat shell spec pins the viewport (no page-level scroll, composer pinned); the trace tap records every notification for 14 days (`TRACE_RETENTION_DAYS`).

## Goals / Non-Goals

**Goals:**
- Carry the plan from the dsh event stream to every connected web client, with rehydration on reload and session re-entry, without SQLite.
- Present it as a right panel on wide viewports and a composer dock on narrow ones, hiding entirely when empty.
- Keep the plan's lifetime user-decided option C: survives turn boundaries, wholesale replacement only.

**Non-Goals:**
- No model-behavior change (no persona/AGENTS.md nudge) — display-only; adoption measured via `trace_events` after ship.
- No plan persistence across server restarts (in-memory only).
- No subagent/workflow progress ("Agents" section of the ZCode panel), no plan-mode (`/plan`) integration, no todo editing from the UI (the list is model-owned; whole-list replacement is the only operation).
- No composer control-layout changes (separate `redesign-composer-controls` change).

## Decisions

### D1 — Capture at `dsh-events.js`, cache on `ctx`, broadcast `todos`

Add `case "todo/write"` in the `handleDshEvent` switch: validate `ev.data.todos` is an array, store it on `ctx.planBySession` (`Map<dshSessionId, { todos, counts }>`), and `ctx.broadcast({ type: "todos", todos, counts })`. Session routing needs no new work — the existing `sid !== ctx.dshSessionId` guard already diverts bot sessions before the switch. A malformed payload logs at debug (DSH_DEBUG) and returns, matching the unmapped-event convention.

*Alternative considered*: deriving the plan from `tool_start` events with name `todo_write` (the args carry the same list). Rejected: the session event is the durable, replay-defined source; tool args are a transport detail, and tool events for non-owner sessions would double-count.

*Counts* are computed server-side (`pending`/`inProgress`/`completed`) once per write rather than per client render; the store keeps them for cheap headers.

### D2 — Lifecycle C: no clearing on turn boundaries, clear on new session, restore on re-entry

`turn/start` and `turn/end` handlers do not touch the plan. New-chat creation (`agent-session.js` `newSession`) sends a `{ type: "todos", todos: [] }` clearing broadcast (and drops the *current* session's cache entry only — other sessions' entries stay for re-entry). On `switch_session`/session load, the server pushes the target session's cached snapshot right after `session_loaded` (empty snapshot clears). The store resets `todos` on `session_loaded` regardless, so the ordering push always wins.

*Alternative considered*: following the official dsh projection semantics (clear on next `turn/start`) — rejected by product decision C: a side panel is not space-constrained like the composer dock, and a plan vanishing on every send reads as a bug there.

### D3 — Rehydration via in-memory `Map`, pushed on connect and session load

Push the current session's snapshot in the `connection` handler and `syncReadyClient` (mirroring `current_permission`). No SQLite table, no dsh log replay. Server restart = empty plan until the next `todo_write` — same honesty class as the permission pin reverting to the deployment default after restart.

*Alternative considered*: persisting plans per chat session in SQLite (`chat_sessions` column or side table) — deferred; it adds a migration and forces us to reimplement replacement semantics that the runtime already owns, for a state that is disposable by nature.

### D4 — Protocol: one server event, computed counts

`{ type: "todos"; todos: TodoItem[]; counts: { pending; inProgress; completed } }` added to `ServerMessage` in `packages/core/src/types/ws.ts` (`TodoItem = { content: string; status: "pending" | "in_progress" | "completed" }`, matching dsh's shape verbatim — no renaming, so raw payloads pass through). One event type for both the live write and the rehydration push; an empty list is a valid clearing event. The store gains `todos` + `counts`, applied in the existing `apply` reducer, reset by `session_loaded`/`clearView`.

### D5 — Layout: two-column wrapper in ChatPage, panel unmounts when empty

`ChatPage` wraps its current column (header/log/composer branch) and the panel in a `flex min-h-0` row; the chat column keeps `min-w-0 flex-1`, the panel is `w-[300px] shrink-0 border-l` and `hidden lg:flex`. The panel mounts only when `todos.length > 0`, so the column re-centers naturally when it goes away (no placeholder div). Mobile nav bar and connection banner stay outside the row (full width). The panel header mirrors the session header's height/padding so the two `border-b` lines align.

`PreviewDrawer` needs no coordination: it is `fixed right-0 z-40` and simply overlays the panel.

*Alternative considered*: panel as an overlay drawer like PreviewDrawer — rejected: the user asked for a persistent ZCode-style column, and a fixed overlay would cover the transcript during exactly the long-running work the panel exists to watch.

### D6 — Narrow-viewport dock lives inside the composer card

Below `lg` the same store drives a collapsed line rendered inside the composer card above the textarea (`lg:hidden`): title + `completed/total` + `·`-joined non-zero status counts. Expansion is a local accordion inside the card; because the composer is pinned by the shell, growth consumes message-log height and cannot push the composer off-screen. Same component renders the item list as the panel (`TodoList`), so iconography/styling exist once.

### D7 — `todo_write` ToolBlock special case

`ToolBlock` gets a name-guarded compact rendering for `todo_write`: one line with the tool display name and the counts derived from the block's own args (or the latest `todos` broadcast when args are unavailable), expandable to the generic body. This is presentation-only; the generic block path is untouched for every other tool.

### D8 — i18n and observability

~8 keys × 5 locales under a new `chat.plan.*` namespace (title, counts join, per-status labels, tooltip, updated-plan line). Post-ship adoption check: `SELECT COUNT(*) FROM trace_events WHERE event_type='todo/write'` over the 14-day window — the decision gate for any future nudge change.

## Risks / Trade-offs

- [The model may rarely call `todo_write` (0 calls in the current 25-turn trace) → the surface stays hidden most of the time] → Accepted (display-only decision); hidden-when-empty makes the empty case invisible rather than broken; the trace query gives the adoption number for a follow-up nudge change.
- [Server restart loses plans mid-work] → Accepted v1 limitation; a restart already drops richer runtime state (permission pin reverts to deployment default). Documented in the spec.
- [Two render surfaces (panel + dock) can drift] → One `TodoList` component, two thin wrappers; e2e covers both.
- [`todo/write` from a resumed dsh session with stale snapshot could overwrite a fresher empty state] → The snapshot is always the runtime's own last write for that session; trusting the runtime's ordering is the same contract every other broadcast already has.
- [Panel width narrows the chat column at `lg` boundary] → The transcript is centered `max-w-*` and clamps; acceptable at 1024px, and the separate composer change widens it.

## Migration Plan

Purely additive: one new WS event type (old clients ignore unknown types — the store's `apply` default is a no-op), new components, no data migration, no protocol removals. Rollback = revert the commit; no state to clean.

## Open Questions

- Exact panel visual polish (accent color for the in-progress treatment, spinner vs. pulse) — resolves during implementation against the existing theme tokens; does not affect contracts.
