## 1. Server: session workspace stamp

- [x] 1.1 Add the additive `workspace` column migration to `chat_sessions` in `db.js` following the existing check-then-alter pattern, and verify a fresh DB and an upgraded DB both end up with the column (`node` smoke: create → insert → read)
- [x] 1.2 Stamp `currentWorkspace()` in `recordMessage` at session-row creation only (never on later turns), and verify with a unit test: two turns across a workspace switch leave the first value intact
- [x] 1.3 Include `workspace` in `listSessions()` output and the `sessions` WS broadcast, and verify the probe sees the field on connect and after a turn

## 2. Web: Workspaces section

- [x] 2.1 Add `workspace` to the session type in `useChatStore`/types and verify the store round-trips it without dropping unknown fields
- [x] 2.2 Rebuild the sidebar session region into the Workspaces section (header with label + search toggle + new-workspace button; collapsible groups keyed by workspace; Ungrouped fallback) and verify rendering with zero, one, and multiple workspaces in the store
- [x] 2.3 Preserve all session-row behaviors inside groups (click-to-switch, active highlight, right-click `ChatSessionMenu`, "+ New chat" navigation) and verify the existing sidebar e2e still passes
- [x] 2.4 Add per-group preview cap + "Show N more" expander with auto-expand of the group holding the active session, and verify a group with >5 sessions paginates and collapses back
- [x] 2.5 Add client-side title-substring search across groups with empty-state and clear-restore, and verify filtering hides empty groups and restores on clear

## 3. Web: new-workspace entry point

- [x] 3.1 Add the new-workspace popover (absolute-path input, validation error slot, mid-conversation confirm) reusing the `set_workspace` contract, and verify a valid switch broadcasts `workspace_changed` and updates the sidebar
- [x] 3.2 Verify an invalid path shows the validation error and leaves the runtime workspace unchanged

## 4. i18n + tests

- [x] 4.1 Add i18n entries (section label, search placeholder, show-more/less, Ungrouped, new-workspace) to all five locales and verify no missing-key console warnings
- [x] 4.2 e2e: sessions stamped with two workspaces render as two groups; switching workspace mid-session does not move the session's group (verify Playwright run passes)
- [x] 4.3 Run `openspec validate add-sidebar-workspaces --strict` and fix any reported issues
