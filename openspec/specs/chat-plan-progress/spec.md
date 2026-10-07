# chat-plan-progress Specification

## Purpose
Surfaces the agent's task plan in the web chat: the server-side capture of the dsh `todo/write` session event, the `todos` WebSocket event with its whole-list-replacement lifecycle, and the plan's presentation — a right-side progress panel on wide viewports and a collapsed dock above the composer on narrow ones.

## Requirements

### Requirement: Server broadcasts the plan on every todo/write

The server SHALL translate each `todo/write` session event belonging to the active web dsh session into a WebSocket `todos` event whose payload carries the complete task list (each item's `content` and `status`) plus per-status counts. The existing session routing SHALL apply: a `todo/write` for a non-web session (e.g. a bot chat) SHALL NOT be broadcast to web clients. Plan events SHALL be failure-isolated — a malformed payload SHALL be ignored without breaking the turn.

#### Scenario: todo/write becomes a todos broadcast
- **WHEN** the dsh runtime emits `session.event` of type `todo/write` with `todos: [{content: "A", status: "completed"}, {content: "B", status: "in_progress"}]` on the web session
- **THEN** the server SHALL broadcast `{ type: "todos", todos, counts: { completed: 1, inProgress: 1, pending: 0 } }` (field naming per the protocol type) to every connected web client

#### Scenario: bot-session plan does not reach the web chat
- **WHEN** a `todo/write` event arrives for a dsh session routed to a bot collector
- **THEN** no `todos` event SHALL be broadcast on the web WebSocket path

#### Scenario: malformed payload is dropped silently
- **WHEN** a `todo/write` event arrives whose `todos` field is missing or not an array
- **THEN** the server SHALL ignore the event and the in-flight turn SHALL continue unaffected

### Requirement: The plan persists across turn boundaries and is replaced wholesale

The plan state SHALL be exactly the most recent `todo/write` snapshot. A new user turn (`turn/start`) and a turn's completion (`turn/end`) SHALL NOT clear or alter the plan — a finished checklist stays visible until a later `todo/write` replaces it wholesale. Starting a new chat session SHALL clear the plan. Switching to another session SHALL clear the local plan, and switching back SHALL restore that session's most recent plan from the server-side cache. After a server restart the plan SHALL be empty until the next `todo/write`.

#### Scenario: sending the next message keeps the plan
- **WHEN** a plan with 6 items (3 completed) is displayed and the user sends a new prompt
- **THEN** the plan SHALL remain displayed unchanged while the new turn runs

#### Scenario: a finished checklist survives turn end
- **WHEN** a turn ends after the last item reached `completed`
- **THEN** the plan SHALL remain displayed with the completed-state header (no items lost, no reset)

#### Scenario: whole-list replacement
- **WHEN** a `todo/write` arrives with a 3-item list while a 6-item plan is displayed
- **THEN** the displayed plan SHALL become exactly the new 3-item list

#### Scenario: new chat clears the plan
- **WHEN** the user starts a new chat session while a plan is displayed
- **THEN** the plan SHALL be cleared and the surface hidden

#### Scenario: switching back restores the plan
- **WHEN** the user switches from session S1 (which had a plan) to S2 and back to S1
- **THEN** S1's most recent plan SHALL be displayed again

### Requirement: Cached plan is pushed on connect and session load

The server SHALL cache the latest plan per dsh session in memory. A client connecting (including mid-boot, once the agent is ready) SHALL receive the cached snapshot for the current session — an empty plan SHALL send the clearing event or nothing, never a stale list. After a `session_loaded` broadcast for a session with a cached plan, the server SHALL push that snapshot so the reloaded view shows the session's plan.

#### Scenario: reload restores the plan
- **WHEN** a browser reloads mid-plan and the WebSocket reconnects
- **THEN** the client SHALL receive the cached `todos` snapshot without any new model activity

#### Scenario: session load pushes its plan
- **WHEN** the server broadcasts `session_loaded` for a session whose cached plan is non-empty
- **THEN** the client SHALL subsequently receive that session's `todos` snapshot

### Requirement: Wide viewports show a right-side progress panel

On viewports at or above the large breakpoint, a non-empty plan SHALL render as a fixed-width right-hand panel beside the chat column (header, message log, and composer stack), not overlapping them. The panel SHALL have its own header showing the completed/total count and a collapse control, and its list SHALL scroll internally without engaging any page-level scrollbar. Item order SHALL be the snapshot's order. Items SHALL render distinguishable by status: pending, in progress (visually emphasized, with an activity indicator), and completed (muted with strikethrough). Long item text SHALL be clamped with the full text available on hover. When the list changes, the panel SHALL bring the first in-progress item into view.

#### Scenario: panel renders beside the chat column
- **WHEN** a non-empty plan exists on a wide viewport
- **THEN** the progress panel SHALL be visible to the right of the message log without overlapping it
- **AND** its header SHALL show `completed/total`

#### Scenario: long plan scrolls inside the panel
- **WHEN** the plan has more items than fit the panel height
- **THEN** the list SHALL scroll internally and the page SHALL NOT gain a scrollbar

#### Scenario: statuses are visually distinct
- **WHEN** the panel renders items of all three statuses
- **THEN** completed items SHALL appear muted with strikethrough, in-progress items SHALL carry the emphasis treatment and activity indicator, and pending items neither

#### Scenario: update scrolls to active work
- **WHEN** a `todos` event replaces the list and an in-progress item exists below the fold
- **THEN** the panel SHALL scroll that item into view

### Requirement: Narrow viewports show a collapsed dock above the composer

Below the large breakpoint, a non-empty plan SHALL render as a single collapsed line inside the composer card, above the textarea, showing the title, the completed/total count, and the non-zero per-status counts joined by a separator. Activating the line SHALL expand the item list inline within the composer card; the composer SHALL remain pinned at the bottom of the viewport (expansion consumes message-log space, never pushes the composer off-screen). Collapsing SHALL restore the single line.

#### Scenario: dock line replaces the panel on narrow viewports
- **WHEN** a non-empty plan exists below the large breakpoint
- **THEN** the right-side panel SHALL NOT render and the composer card SHALL show the collapsed dock line above the textarea

#### Scenario: expanding the dock keeps the composer pinned
- **WHEN** the user expands the dock on a narrow viewport with a long transcript
- **THEN** the item list SHALL appear inside the composer card and the composer SHALL remain fully visible at the bottom of the viewport

### Requirement: An empty plan hides the surface entirely

When no plan exists (never written, cleared, or emptied), neither the panel nor the dock SHALL render, and no reserved space or placeholder SHALL remain. The chat column SHALL re-center as if the surface did not exist.

#### Scenario: no plan, no surface
- **WHEN** the chat renders with an empty plan state
- **THEN** neither the panel nor the dock SHALL be present in the DOM

#### Scenario: last write empties the list
- **WHEN** a `todo_write` snapshot with an empty `todos` array arrives
- **THEN** the surface SHALL disappear and the layout SHALL re-center
