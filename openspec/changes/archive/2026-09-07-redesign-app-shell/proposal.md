## Why

The app shell grew one entry point at a time and now has no predictable rule for where anything lives. The model control exists in four places (ControlStrip menu, sidebar chip, ChatHeader text, `/models` page + Settings menu item); the eight sidebar tabs mix the product surface (Chat) with operator configuration (MCP, Skills, Models) at the same visual weight; the Settings popover and the nav overlap arbitrarily (Models is in both, System Status is only in the popover); and the sidebar footer has become a six-control junk drawer that permanently spends vertical space on a language `<select>`. The UI is also dark-only with no way to switch, which blocks users in bright environments and is out of step with every comparable product.

## What Changes

- **BREAKING** The sidebar nav collapses from eight entries to five work surfaces: Chat, Knowledge, Agents, Bots, Trace. Configuration entries (MCP Servers, Skills, Models) leave the nav.
- A new in-app **Settings modal** replaces the Settings popover, routed at `/settings/:section` with five sections: General (theme, language), Models, MCP, Skills, System Status. Opened by the sidebar gear or `Cmd/Ctrl + ,`, dismissed by Escape / backdrop / close, and deep-linkable.
- **BREAKING** The standalone routes `/models`, `/mcp`, `/skills`, `/dashboard` redirect to their `/settings/:section` equivalents. Their existing page components are reused as modal panes — content and behavior are unchanged, only the container.
- The **ControlStrip** becomes the single runtime-control surface for a turn: workspace, agent, model, reasoning effort, commands. The agent selector moves here from the sidebar footer.
- The **sidebar footer** collapses to one row (connection status dot + gear). The agent `<select>`, model chip, "Clear chat" button, and locale `<select>` are removed from it — clear-chat moves into the existing per-session context menu, locale into Settings → General.
- The **ChatHeader** keeps only the editable session title and an overflow (`⋯`) menu. The duplicated `model · agent · status` strip is removed; ControlStrip and the sidebar footer already report that state.
- New **light / dark / system** theming. `globals.css` splits its single `@theme` block into `[data-theme="light"]` / `[data-theme="dark"]`, with `:root` following `prefers-color-scheme`. Shiki code highlighting follows the active theme. The choice persists in `localStorage`.
- The e2e suite is updated for the new shell: existing specs that reach for removed selectors are rewritten against the new ones, a `openSettings()` helper is added, and two new specs cover the settings modal and theme switching.

## Capabilities

### New Capabilities
- `settings-surface`: the in-app Settings modal — its section registry, `/settings/:section` routing and deep-linking, open/dismiss behavior, the `Cmd/Ctrl + ,` shortcut, and how legacy standalone routes redirect into it.
- `theming`: light / dark / system theme selection — the token structure, resolution of `system` against `prefers-color-scheme`, persistence, syndication to Shiki, and the no-flash requirement on first paint.

### Modified Capabilities
- `app-navigation`: the canonical tab set changes from six configuration-and-workspace entries to five work surfaces (Chat, Knowledge, Agents, Bots, Trace); MCP Servers, Skills, and Models are no longer nav tabs; the sidebar footer contents are reduced.
- `chat-ui-shell`: ChatHeader loses its `model · agent · status` strip and gains an overflow menu; the sidebar footer collapses to a single status + gear row.
- `chat-composer-controls`: the ControlStrip gains an agent control and is designated the sole surface for per-turn runtime configuration.
- `model-selection`: the sidebar model chip is removed; the model is selected from the ControlStrip and configured in Settings → Models.
- `extension-management-ui`: the MCP Servers and Skills pages move from the top-level routes `/mcp` and `/skills` to Settings sections, with the old paths redirecting.
- `system-status-dashboard`: the System Status page moves from `/dashboard` to a Settings section, with the old path redirecting.
- `session-list-management`: the session context menu gains a Clear action alongside Delete, and becomes reachable from the chat header overflow as well as from a right-click on a session row.
- `internationalization`: the locale selector moves from the sidebar footer to Settings → General.
- `e2e-testing`: the suite's shell selectors and navigation helper change; two specs are added.

## Impact

**Frontend (`web/src/`)** — `App.tsx` (routes, redirects, modal mount), `components/Sidebar.tsx` (nav list, footer), `components/ChatHeader.tsx`, `components/ControlStrip.tsx`, `components/SettingsMenu.tsx` (replaced by the modal), `components/ChatSessionMenu.tsx` (gains clear-chat), `styles/globals.css` (theme split), `components/Markdown.tsx` (Shiki theme), plus a new settings modal component tree, a `useTheme` hook, and locale bundles for all five languages (`en`, `zh-CN`, `es`, `fr`, `ja`).

**Tests (`e2e/`)** — `helpers.js` plus the ten specs that reference removed selectors (`app`, `nav-persistence`, `settings-menu`, `i18n`, `model-selection`, `llm-models`, `dashboard`, `chat-polish`, `composer-stop`, `live`); two new specs. The remaining fourteen specs navigate by URL and are unaffected because every legacy route continues to resolve.

**Not affected** — no backend, WebSocket protocol, or REST contract changes. The server continues to serve `web/dist/` with a SPA fallback, so `/settings/*` resolves client-side like every other route.
