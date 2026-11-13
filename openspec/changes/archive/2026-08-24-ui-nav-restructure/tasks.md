# Tasks — ui-nav-restructure

## 1. Sidebar nav and Settings dropdown
- [x] 1.1 Replace `NAV_BASE` in `web/src/components/Sidebar.tsx` with the new tab set: Chat, Knowledge, Agents, MCP Servers, Skills, Models (6 entries)
- [x] 1.2 Add i18n keys `nav.knowledge`, `nav.agents`, `nav.mcp`, `nav.skills`, `nav.models` to all 5 locales
- [x] 1.3 Create `web/src/components/SettingsMenu.tsx` (gear button + popover with System Status / LLM Models / OpenConnector)
- [x] 1.4 Wire SettingsMenu into Sidebar footer (next to the language select)
- [x] 1.5 Add i18n keys `settingsMenu.title`, `settingsMenu.status`, `settingsMenu.models`, `settingsMenu.openconnector` to all 5 locales

## 2. Routes and redirects
- [x] 2.1 In `web/src/App.tsx`, register the new routes: `/knowledge`, `/agents` (kept), `/mcp`, `/skills`, `/models`
- [x] 2.2 Add a `<Route path="/models" element={<ModelsPagePlaceholder />}>` placeholder
- [x] 2.3 Remove the `/extensions` and `/extensions/mcp`, `/extensions/skills` routes
- [x] 2.4 Add `<Route path="/extensions" element={<Navigate to="/mcp" replace />} />` and the same for `/extensions/mcp` and `/extensions/skills`
- [x] 2.5 Add `<Route path="/documents" element={<Navigate to="/knowledge" replace />} />` for the legacy Documents path
- [x] 2.6 Delete `web/src/pages/ExtensionsParent.tsx`
- [x] 2.7 Create `web/src/pages/ModelsPagePlaceholder.tsx` (renders a simple "Models — coming soon" card)

## 3. Agents page sub-tabs
- [x] 3.1 In `web/src/pages/AgentsPage.tsx`, switch from a single scroll to a Tabs component (use the existing `@/components/ui/tabs` if present, else build with the dialog primitive)
- [x] 3.2 Read the active tab from `?tab=apps|agents` (default `agents`) via `useSearchParams`
- [x] 3.3 Update `setSearchParams` on tab change so deep-links round-trip
- [x] 3.4 Move the existing Agents section into the Agents tab and the Apps section into the Apps tab (no logic change)

## 4. System Status page (renamed Dashboard)
- [x] 4.1 Rename `web/src/pages/DashboardPage.tsx` to `web/src/pages/SystemStatusPage.tsx` (or keep filename, update the page title only — pick one and be consistent)
- [x] 4.2 Regroup the four existing sections into three buckets: **Health** (servers), **Active Configuration** (provider / model / agent / OpenConnector-enabled), **Resources** (documents / collections / MCP / uptime)
- [x] 4.3 Add a "Manage" link on each Active Configuration row pointing to the relevant page
- [x] 4.4 Add i18n keys `systemStatus.title`, `systemStatus.health`, `systemStatus.activeConfig`, `systemStatus.resources`, `systemStatus.manage` to all 5 locales
- [x] 4.5 Keep the legacy `dashboard.*` keys as fallbacks for one release (alias them in the t() calls)

## 5. Session right-click delete (UI)
- [x] 5.1 Create `web/src/components/ChatSessionMenu.tsx` (context menu component, positioned at click point, with Delete entry)
- [x] 5.2 Wire `onContextMenu` and `onKeyDown` (Shift+F10) on each session row in Sidebar
- [x] 5.3 Add the confirmation dialog (reuses `@/components/ui/dialog`) with Cancel / Delete buttons
- [x] 5.4 On confirm, call `DELETE /api/chat-history/sessions/:id`; on success, the broadcast `sessions` event updates the store and the row disappears
- [x] 5.5 On failure, show an inline error message; on 409 (active session), disable the Delete entry in the menu with a tooltip
- [x] 5.6 Add i18n keys `sessionMenu.delete`, `sessionMenu.confirmTitle`, `sessionMenu.confirmBody`, `sessionMenu.cannotDeleteActive`, `sessionMenu.deleteFailed`

## 6. Session delete (server)
- [x] 6.1 In `server.js`, add `app.delete('/api/chat-history/sessions/:id', ...)` that delegates to `chat-history.js`
- [x] 6.2 In `chat-history.js`, add `deleteSession(id)` that unlinks the on-disk file and deletes the SQLite mirror row, both under the existing per-session mutex
- [x] 6.3 Reject deletion of the current session (compare against `currentSessionId`); return 409 with a clear error
- [x] 6.4 After successful delete, broadcast the refreshed `sessions` WS event to all connected clients
- [x] 6.5 Also call `dshBridge.deleteSession(id)` so dsh's own persistence does not resurrect the entry

## 7. Tests
- [x] 7.1 Update e2e selectors that reference `nav-extensions` to use the new `nav-mcp` / `nav-skills` (or add new tests for the promoted tabs)
- [x] 7.2 Add e2e coverage for the new routes: visit `/mcp`, `/skills`, `/knowledge` and assert the right page renders
- [x] 7.3 Add e2e coverage for `/extensions` → `/mcp` and `/documents` → `/knowledge` redirects
- [x] 7.4 Add e2e coverage for the Settings menu (open, click OpenConnector, assert navigation)
- [x] 7.5 Add e2e coverage for the Agents sub-tab (default Agents, switch to Apps, deep-link via query param)
- [x] 7.6 Add e2e coverage for right-click delete (open menu, confirm, assert row removed); plus the active-session-disabled-Delete case
- [x] 7.7 Add unit tests for `chat-history.deleteSession()` (happy path, current-session rejection, missing id)
