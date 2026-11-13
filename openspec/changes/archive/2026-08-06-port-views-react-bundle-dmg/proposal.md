## Why

The React migration started in `redesign-chat-ui-react-shadcn` only ported the **chat** surface. Every other view - Documents, Dashboard, Chat History - still ships from the legacy vanilla `public/app.js` (1389 lines), and the React sidebar links to them via plain `<a href>` tags that bounce the user out of the SPA to the legacy page. The result is a split-brain frontend: two toolchains, two styling systems, two WebSocket connections when navigating, and no shared state. Meanwhile the self-contained `.dmg` (bundled OpenConnector + LiteLLM) specified in the archived `bundle-services-in-electron` change was never actually built - its build scripts failed at runtime (Node 25 type-stripping, proxy, broken postinstall). This change finishes the React migration, retires the vanilla frontend, adds full e2e coverage, and makes the bundled `.dmg` actually build and run.

## What Changes

- **BREAKING (frontend only)**: the React SPA becomes the sole frontend. `server.js` serves `web/dist/` at `/` (not just `/chat`). The legacy `public/` directory is deleted. The vanilla WS/REST contracts are unchanged - the React app talks to the same `ws://<host>/` and `/api/*` endpoints.
- Add React Router to `web/`. The sidebar nav switches from `<a href>` links to in-app `<Link>`/routes. New routes: `/documents`, `/dashboard`, `/history` (chat history), `/openconnector`, `/litellm`.
- New React pages built by us:
  - **DocumentsView** - file/text/URL upload, document list, ingestion status, per-doc query, collections (create/list/delete/add docs/query).
  - **DashboardView** - system status: supervisor server states, model/provider config, document counts, MCP tool count.
  - **ChatHistoryView** - session list + read-only message viewer for past sessions.
- OpenConnector and LiteLLM stay as **embedded third-party UIs** (they ship their own native dashboards). Their React "pages" are thin iframe wrappers loading the existing `/oc-web` proxy and the LiteLLM admin URL - no reimplementation.
- Full e2e test coverage (Playwright) for every React view: documents upload + collection query, dashboard renders, chat-history read, OC iframe loads, litellm iframe loads, plus the existing chat/model/thinking tests.
- **Fix the broken `.dmg` build**: the `bundle-services-in-electron` build scripts (`scripts/build-openconnector.js`, `scripts/build-python-litellm.sh`) failed due to (1) Node 25's experimental type-stripping breaking the OC postinstall `.ts` scripts, (2) proxy not threaded to `git`/`curl`, (3) wrong python-build-standalone URL. Rewrite them to actually produce `resources/openconnector/`, `resources/python/`, `resources/litellm/venv/`, then run `electron-builder` to ship a self-contained `dist/Platform-<ver>-arm64.dmg` with bundled OpenConnector + LiteLLM.

## Capabilities

### New Capabilities
- `documents-view`: React UI for document ingestion (file/text/URL upload, status), the document list, per-document query, and collections (create/list/delete/add-docs/query). Replaces the vanilla Documents + Collections tabs.
- `dashboard-view`: React system dashboard - supervisor server states, active provider/model, document + collection counts, connected MCP tools. Read-only.
- `embedded-service-views`: React wrapper pages that embed the OpenConnector native UI (via `/oc-web`) and the LiteLLM admin UI as same-origin iframes within the app shell, instead of vanilla tabs.

### Modified Capabilities
- `chat-ui-shell`: the shell hosts multiple views via client-side routing (not chat-only). Sidebar nav becomes in-app routes. The legacy vanilla coexistence + `/` -> `/chat/` redirect requirements are replaced by "React SPA is the sole frontend served at `/`".
- `e2e-testing`: full Playwright coverage extended to every React view (documents, dashboard, chat-history, embedded service iframes), not just the chat surface.

## Impact

- **web/**: add `react-router-dom`; new `pages/` directory (DocumentsPage, DashboardPage, ChatHistoryPage, EmbeddedServicePage); `App.tsx` gains a `<Routes>`; `Sidebar.tsx` nav switches from `<a>` to `<Link>`; new hooks for `/api/documents/*`, `/api/chat-history/*`, supervisor status. shadcn primitives extended as needed.
- **public/**: **deleted** entirely (`app.js`, `index.html`, `style.css`).
- **server.js**: static serving collapses to `web/dist/` at `/` + `/assets/*`. The `/` -> `/chat/` redirect is removed. `/oc-web` reverse proxy and `/api/*` routes unchanged. Chat-history + documents REST APIs unchanged.
- **e2e/**: new specs `documents-react.spec.js`, `dashboard.spec.js`, `chat-history-react.spec.js`, `embedded-views.spec.js`; existing specs updated to target React selectors (`[data-testid=...]`).
- **scripts/build-openconnector.js** + **scripts/build-python-litellm.sh**: rewritten to actually succeed - thread proxy to git/curl, run OC postinstall via a Node that doesn't trip type-stripping, fix python-build-standalone URL, verify-bundle enforces outputs.
- **electron-builder.yml**: unchanged structure (already declares the bundled extraResources from the archived change); this change makes the build actually populate them.
- **No backend module changes**: `documents.js`, `chat-history.js`, `open-connector.js`, `mcp-bridge.js`, `server.js` orchestrator logic untouched. WebSocket protocol + REST contracts unchanged.
- **Bundle size**: `.dmg` ~250-300MB compressed (Electron + Node + server.js + node_modules + OpenConnector dist + python-build-standalone + LiteLLM venv).
