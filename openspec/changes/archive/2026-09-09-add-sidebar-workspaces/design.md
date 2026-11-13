# Design — add-sidebar-workspaces

## Context

Sessions mirror into SQLite (`chat_sessions`: id, title, createdAt,
updatedAt, sdk `path` column) via `recordMessage`; the sidebar renders the
`listSessions()` payload from the `sessions` WS broadcast. The runtime
workspace lives only in agent-session state (`currentWorkspace()`,
`listWorkspaces()` = current + recents, `set_workspace` → restart →
`workspace_changed` broadcast). The `chat_sessions` table already has the
"add a column + backfill-on-write" precedent (`path`).

## Goals / Non-Goals

**Goals:**
- One server-side fact (session → workspace) drives everything; all
  grouping/search/pagination is client-side over the existing payload.

**Non-Goals:**
- No workspace management (rename, recents editing, delete) — the
  screenshot's "manage" button is deferred until there is a real object to
  manage; workspaces remain "the current path + recents".
- No server-side search or pagination endpoints — the payload is already in
  the hundreds at worst; filtering stays client-side.
- No change to the composer strip's workspace control.

## Decisions

### D1 — Stamp on first mirror, never re-stamp
`recordMessage` writes `currentWorkspace()` when it creates the session row
(the same moment it derives the title). Re-stamping on later turns would
make group membership move under the user mid-conversation; a session is a
artifact of the workspace it started in. Sessions resumed across a
workspace switch keep their original group — matching how dsh treats a
session's cwd (fixed at session creation).

### D2 — Additive column + count-bounded read
`ALTER TABLE chat_sessions ADD COLUMN workspace` guarded by the existing
migration path (check-then-alter like prior column additions); index only if
query plans show need — the client receives the full payload either way, so
no index ships in v1. `listSessions()` selects the column; rows pre-dating
the migration return NULL → serialized as absent → client renders
"Ungrouped".

### D3 — Grouping/search/pagination live entirely in `Sidebar.tsx`
The `sessions` broadcast shape gains one field; no new WS messages, no new
REST endpoints. The sidebar derives groups with a `useMemo` (workspace →
sorted sessions), keeps a Set of collapsed group ids and a per-group
expanded flag, and filters by title substring when a query is active. The
preview cap mirrors the welcome screen's `RECENT_PREVIEW = 5`. While a query
is active, groups with matches render expanded and unpaged — a match hidden
inside a collapsed group reads as "not found".

### D4 — The new-workspace action is the existing switch, re-skinned
The header button opens a small popover with an absolute-path input — the
same validation regex, mid-conversation `window.confirm`, `set_workspace`
message, and pending treatment as the composer's `strip-workspace` control.
Extracting that logic into a shared helper is optional; duplicating the
~20 lines is acceptable if the extraction would couple two components that
evolve separately. The button is an entry point, not a second contract.

### D5 — Search state is ephemeral
The query lives in component state (not the store, not the URL): it is a
transient lens over the list, and deep-linking a filtered sidebar has no
use case. The search toggle collapses back to the header when dismissed,
clearing the query.

## Risks / Trade-offs

- [Sessions created before the migration land in Ungrouped] → Accepted and
  spec'd; a one-off backfill could guess from the dsh session file's cwd but
  the data is not trustworthy enough to bother.
- [Very large session counts render long lists] → Per-group pagination caps
  the DOM; search operates over the payload array, which stays fast to
  thousands of rows.
- [Current-workspace group could stay hidden when collapsed] → The group
  containing the active session auto-expands on session switch.

## Migration Plan

Deploy order irrelevant (server column is backward-compatible; old clients
ignore the extra field). Rollback: the column is inert if unread.

## Open Questions

- None blocking.
