# ui-nav-restructure

## Why

The current sidebar mixes concepts in a way that doesn't match how people actually use the product. "Extensions" is a parent shell hiding MCP Servers and Skills — two independently useful surfaces that the user clicks twice to reach. OpenConnector sits at the top level but is itself a configured MCP server (it shows up in the MCP list), so it duplicates a tab. The Dashboard is operator-oriented (server PIDs, ports) and is the natural place for a few other "configure" surfaces, but it lives next to the user-facing tabs with no way to expand. And the session list in the sidebar has no delete path — once a session exists, only the file system can remove it.

The fix is to **flatten the user-facing tabs** (Chat, Knowledge, Agents, MCP, Skills, Models) and **fold the operator surfaces into a Settings entry** in the sidebar footer. The result: a one-click jump to anything a user actually does, and a clear "this is for ops/config" affordance for the rest.

## What Changes

- **Promote** MCP Servers, Skills, and Agents & Apps to **top-level tabs**. Remove the `/extensions` parent and the two-card selector page.
- **Move** OpenConnector from a top-level tab into a **Settings dropdown** (gear icon in the sidebar footer). The `/openconnector` route still works; the nav entry moves.
- **Rename** Dashboard → **System Status** and regroup its content into Health / Active Configuration / Resources sections.
- **Add** a new top-level **Models** tab (`/models`) — the route + empty placeholder. Full UI is filled in by the follow-up `dsh-llm-models-page` change.
- **Add** a **right-click context menu** on each session row in the sidebar: Delete (with confirm), plus a future Rename hook. Backed by a new `DELETE /api/chat-history/sessions/:id` endpoint.
- **Split** the Agents page into two **sub-tabs** (Agents | Apps) — currently both are scrolled on one page with a `<h2>` between them; sub-tabs make the boundary explicit and let the URL be deep-linkable (`/agents?tab=apps`).
- **Add** a **Settings dropdown** in the sidebar footer (gear icon, with `System Status` / `LLM Models` / `OpenConnector` items).
- **i18n**: new keys for renamed/added nav items, Settings menu, and right-click menu.

No WS protocol changes. No backend model/provider changes. The MCP "Installed / Market" tabs and the OpenConnector iframe proxy are unchanged — only the route paths move.

## Capabilities

### New Capabilities
- `session-list-management`: server-driven right-click menu on chat sessions (delete with confirm; rename hook for later).
- `system-status-dashboard`: read-only system health view surfaced at `/dashboard` and under Settings.

### Modified Capabilities
- `app-navigation`: tab set + ordering changes; Settings dropdown introduced; routes for MCP / Skills / Agents promoted.
- `extension-management-ui`: split into the underlying MCP and Skills capabilities; the `/extensions` parent page is removed.
- `agent-catalog`: route moves to top-level `/agents`; the page splits Agents vs Apps into sub-tabs.
- `open-connector-ui`: route still `/openconnector`, but the nav entry moves into Settings.
- `chat-history`: add `DELETE /api/chat-history/sessions/:id`; broadcast refreshed `sessions` list.

## Impact

- **`web/src/components/Sidebar.tsx`**: replace `NAV_BASE` with the new tab list; add Settings gear button + dropdown menu; add right-click handler on session rows.
- **`web/src/App.tsx`**: rewire `<Route>` paths; add `/models` placeholder route; remove `/extensions` parent.
- **`web/src/pages/`**:
  - `ExtensionsParent.tsx` → **delete**
  - `ExtensionsPage.tsx` → keep, called from `/mcp` and `/skills` directly (or factor to a generic tab-page wrapper)
  - `AgentsPage.tsx` → add sub-tabs (Agents | Apps)
  - `DashboardPage.tsx` → rename to `SystemStatusPage.tsx` (or keep filename, rename copy); regroup sections
  - `ModelsPage.tsx` → **new** (placeholder for change B)
- **`web/src/components/extensions/`**: unchanged (still render at `/mcp` and `/skills`).
- **`web/src/components/ChatSessionMenu.tsx`** → **new** (right-click context menu, confirmation dialog).
- **`server.js`**: add `DELETE /api/chat-history/sessions/:id`; on delete, broadcast refreshed `sessions` list via WS.
- **`chat-history.js`**: expose `deleteSession(id)`; the store layer already has the read path; delete unlinks the file.
- **`web/src/locales/*/common.json`**: add `nav.knowledge`, `nav.models`, `nav.agents`, `nav.mcp`, `nav.skills`; `settingsMenu.*`; `sessionMenu.*`; `systemStatus.*`.
- **e2e tests**: update selectors that reference `/extensions` or `nav-extensions`; add coverage for right-click delete + sub-tabs.
- **Risk**: route renames break any external deep-link. We keep the old routes as `<Navigate replace>` aliases during the transition window (or simply: no aliases — this is an internal dev build; the user is the only consumer).

## Out of scope (deferred to other changes)

- Full Models UI (add/edit/delete providers, test connection) → `dsh-llm-models-page`.
- Welcome state, header bar, slash-command picker → `chat-main-page-polish`.
- The `Settings` menu's other potential entries (e.g. account, theme) → not in scope.
