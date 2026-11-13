# add-sidebar-workspaces

## Why

Workspaces are switchable only through a control buried in the composer
strip, and the sidebar session list is a flat chronology. A user with several
projects cannot see which workspace a past conversation belongs to, find a
session in a specific project, or switch projects from the same surface
where their sessions live. The harness-style sidebar pattern — a Workspaces
section where sessions group under the workspace they ran in — needs one
server-side fact that does not exist yet: which workspace each session used.

## What Changes

- `chat_sessions` gains a `workspace` column: the runtime workspace stamped
  when the session's first turn is mirrored (additive migration). The
  sessions list payload and the `sessions` WebSocket broadcast carry it.
  Existing rows have no workspace and surface as an "Ungrouped" group.
- The sidebar's session region becomes a Workspaces section: a header row
  (label, search toggle, new-workspace action) followed by collapsible
  workspace groups, each listing its sessions (title + relative time, active
  session highlighted, right-click menu preserved). Sessions render under
  the workspace they were stamped with; the current workspace's group is
  expanded by default.
- Per-group pagination: a capped preview (5 sessions) with a "Show N more"
  expander, so a long history does not starve the other groups.
- Search filters sessions by title (and workspace name) across groups,
  client-side, with the empty state preserved.
- The new-workspace action reuses the existing `set_workspace` flow
  (absolute-path input, server validation, mid-conversation confirm) from
  the sidebar — same semantics as the composer control, one more entry
  point, no new server contract.
- The composer strip's workspace control is unchanged.

## Capabilities

### New Capabilities
- `sidebar-workspaces`: the sidebar Workspaces section — workspace-grouped
  sessions, search, per-group pagination, the Ungrouped fallback, and the
  new-workspace entry point.

### Modified Capabilities
- `app-navigation`: the sidebar chat-session list requirement becomes the
  workspace-grouped form (row behaviors — new-chat action, active highlight,
  click-to-switch, context menu — preserved).
- `chat-history`: session records gain the workspace the session ran in,
  exposed through the sessions list and WebSocket broadcast.

## Impact

- `db.js` / migration: one added column on `chat_sessions` (+ index),
  following the existing additive migration path.
- `chat-history.js`: stamp on first mirror, include in `listSessions`.
- `server/agent-session.js`: sessions broadcast includes the field (no new
  WS messages).
- `web/src/components/Sidebar.tsx`: session region rebuilt into the section
  (grouping, search, pagination); `ChatSessionMenu` and "+ New chat"
  behaviors preserved.
- i18n: section header, search placeholder, show-more, Ungrouped labels in
  five locales.
