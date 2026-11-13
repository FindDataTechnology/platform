# Design — ui-nav-restructure

## Context

The current sidebar mixes user-facing surfaces (Chat, Documents, Agents) with operator surfaces (Dashboard, OpenConnector) and nests MCP/Skills under a parent "Extensions" page. The user is the only consumer, so this is an internal reshuffle — no external API contracts change, but the JSX + route surface does.

The change also adds a small but long-missing piece: a way to delete a session from the UI. Today, sessions are created via `new_session` and only the file system can remove them; the new `DELETE /api/chat-history/sessions/:id` REST route closes that loop.

The two new capabilities (`session-list-management`, `system-status-dashboard`) are split out from the broader nav work because they have their own behavior contracts (right-click menu + dialog flow; read-only system health view) that justify standalone specs.

## Goals / Non-Goals

**Goals**
- Flatten top-level nav to 6 user-facing tabs: Chat / Knowledge / Agents / MCP Servers / Skills / Models.
- Move operator surfaces (System Status, OpenConnector) into a Settings dropdown in the sidebar footer.
- Add a right-click context menu on session rows with Delete.
- Add a tabbed layout to the Agents page (Agents | Apps).
- Rename Dashboard → System Status and regroup content into Health / Active Configuration / Resources.

**Non-Goals**
- Multiple-window support, keyboard-first navigation, theme switching.
- Bulk session operations (delete all, archive).
- Settings page beyond a 3-item dropdown (no preferences, no theme).
- A new session rename UI in this change (the WS message arrives in change C, where the rename input lives in the chat header).

## Decisions

### D1: Settings is a dropdown, not a page

A separate `/settings` page adds a tab that nobody visits; a dropdown in the sidebar footer surfaces the operator surfaces where they belong (always visible, always one click away) without polluting the top-level nav. The dropdown is implemented as a Radix-style popover anchored to the gear button; the existing `@/components/ui/dialog` primitive has the right look-and-feel hooks. Escape, click-outside, and item-click all close it.

Alternatives considered:
- **Settings as a top-level tab** — rejected: 7 top-level tabs is too many, and the items inside are configuration not "doing".
- **Settings as a slide-out side panel** — rejected: requires new layout shell, no precedent in the app.

### D2: Right-click menu uses native `contextmenu` event + Radix Menu

A native right-click listener on each session row is sufficient (no library needed); the menu is a small portal-rendered list positioned at the click point. We use the existing `@/components/ui/dialog` for the confirmation dialog so styling matches. `Shift+F10` keyboard shortcut is wired in the same handler.

Alternatives considered:
- **Hover-only menu (long press / 3-dot button)** — rejected: requires extra affordance; right-click is a known idiom for power users and matches the user's request.
- **Confirmation via inline popover instead of a dialog** — rejected: destructive action deserves a hard confirm; inline popovers are easy to misclick.

### D3: Legacy `/extensions/*` paths redirect, not 404

`/extensions` → `/mcp`, `/extensions/mcp` → `/mcp`, `/extensions/skills` → `/skills`. The redirects are `Navigate replace` from `App.tsx`, no server-side change. This preserves any bookmarks the user has and makes the transition invisible during normal use.

### D4: `DELETE /api/chat-history/sessions/:id` removes both stores

The current architecture has two stores: an on-disk JSON file per session and a SQLite mirror. Both must be kept in sync. The new handler unlinks the file (atomic `rm`) and deletes the SQLite row, then broadcasts the refreshed `sessions` list. dsh's own session persistence is also removed by calling the dsh bridge's `deleteSession(id)` so reopening the dsh session does not resurrect the entry.

### D5: Active session delete is rejected at server AND client

The server returns 409 with a clear error if the requested id is the current session. The UI also disables the Delete entry on the active session row (with a tooltip) to prevent the obviously-wrong action from ever firing. This is a defense-in-depth pattern — the server is the source of truth, the UI is a UX hint.

### D6: Sub-tabs in Agents page use a simple local state + URL query

`?tab=apps` for deep-link, `?tab=agents` (or absent) for the default. The component reads `useSearchParams`, defaults to "agents", and pushes a `setSearchParams` on click. No need for a router context provider — `react-router-dom` already has the right hooks.

### D7: System Status page reuses `DashboardPage.tsx`

The existing `DashboardPage.tsx` already does the right things (calls `/api/supervisor/status`, renders the four sections). The change is:
- Rename file to `SystemStatusPage.tsx` (or keep filename, rename copy).
- Regroup the four sections into the three buckets: Health (servers), Active Configuration (model + provider + agent + OpenConnector-enabled), Resources (documents + collections + MCP tool count + uptime).
- Add a "Manage" link on each Active Configuration row.
- Update the i18n copy from `dashboard.*` to `systemStatus.*` (and keep the old `dashboard.*` keys for one release as aliases).

## Risks / Trade-offs

- **Route renames break external deep-links** → Mitigation: `/extensions/*` and `/documents` redirect. No `/dashboard` or `/openconnector` change so those are safe.
- **Concurrent session delete + new prompt** → Mitigation: the new `done` event from a prompt always runs `recordMessage()` first; the delete handler holds the same per-session mutex the prompt path uses (`chat-history.js` already has one). Worst case: the delete waits a few ms; nothing is lost.
- **Settings menu not keyboard-discoverable** → Mitigation: the gear button has `aria-label="Settings"`, opens on Enter, and the menu items are reachable via Tab/Arrow keys. We don't add a `?` shortcut to open it — Settings is not on the critical path.
- **Migrating i18n keys for "Dashboard"** → Mitigation: keep both `dashboard.*` and `systemStatus.*` keys for one release. The old `dashboard.*` are removed in a follow-up cleanup change after users are on the new strings.

## Migration Plan

This is a single deployment (no phased rollout). Steps:

1. Land the new routes + Sidebar changes behind a feature flag `PLATFORM_UI_NAV_V2` (default off) so we can roll back by env var if needed.
2. Run the e2e suite against both `v1` and `v2` paths for one cycle.
3. Flip the flag default to `on`.
4. Remove the flag in a follow-up change after one release.

The DELETE endpoint is non-breaking (purely additive) and lands without a flag.

## Open Questions

- Should the Settings dropdown items deep-link to the same `/dashboard`, `/openconnector` routes (URL never changes) or to new aliases (`/settings/status`, `/settings/oc`)? → **Decision deferred to implementation**: use the existing routes; aliases can be added later if URLs become user-visible.
- Should session rename live in this change or in change C? → **Already decided**: C owns the WS message and the rename UI in the chat header; this change only adds the right-click menu (Delete only). Rename is a v2 menu item.
