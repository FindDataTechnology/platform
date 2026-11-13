## Context

The React migration is half-done. `web/` (Vite + React 19 + TS + Tailwind v4 + shadcn) ships a polished chat surface at `/chat`, but every non-chat view (Documents, Dashboard, Chat History, OpenConnector, LiteLLM) still lives in the 1389-line vanilla `public/app.js`. The React `Sidebar.tsx` acknowledges this with plain `<a href="/documents">` links that hard-navigate away from the SPA to the legacy page - losing React state, the WebSocket connection, and requiring a full page load each time. There is no router in `web/` yet; `App.tsx` renders `<Chat>` unconditionally.

On the packaging side, the archived `bundle-services-in-electron` change specified a self-contained `.dmg` (bundled OpenConnector + LiteLLM) and synced its specs to `openspec/specs/desktop-supervisor/`, `first-run-bootstrap/`, `preferences-ui/`. But the build scripts never actually ran to completion:
1. Node 25 enables `--experimental-default-type=module` type-stripping by default, which crashes when loading `.ts` files *inside* `node_modules` (the OC repo's postinstall runs `node scripts/ensure-generated.ts` and its `build` runs `node scripts/generate-provider-registry.ts`).
2. The proxy wasn't threaded to `git clone` or `curl`, so network calls to GitHub timed out.
3. The python-build-standalone URL was wrong (404 -> 9-byte error page).

Constraints (non-negotiable):
- WebSocket protocol + REST contracts unchanged - the React app uses the same `ws://<host>/` and `/api/*` as vanilla.
- OpenConnector + LiteLLM are third-party projects with their own native UIs - we embed, not reimplement.
- `asar: false`, `npmRebuild: false` (bundled Node runs native addons).
- Graceful degradation: missing optional service doesn't block launch.

## Goals / Non-Goals

**Goals:**
- One React SPA, one router, one WebSocket connection. `public/` deleted.
- Documents, Dashboard, Chat History as first-class React pages with `[data-testid]` hooks for e2e.
- OpenConnector + LiteLLM embedded as iframes inside the React shell (thin wrappers, their native UIs intact).
- Playwright e2e covering every React view.
- A `dist/Platform-<ver>-arm64.dmg` that actually builds and launches with bundled OC + LiteLLM, zero external services required.

**Non-Goals:**
- Backend restructuring (server.js, documents.js, etc. untouched).
- Redesigning OpenConnector's or LiteLLM's native UIs.
- Windows/x64 packaging (mac arm64 only, per the archived change's scope).
- Auto-update of bundled binaries at runtime.
- Preferences UI rework (the archived change's `preferences-ui` spec stands).

## Decisions

### D1: react-router-dom with a flat route table

**Decision.** Add `react-router-dom` (v7, latest). Routes: `/chat` (default), `/documents`, `/dashboard`, `/history`, `/openconnector`, `/litellm`. `<BrowserRouter>`. Sidebar nav switches from `<a href>` to `<Link to>`. `/` redirects to `/chat`.

**Rationale.** The shell already needs view-switching; a router is the standard solution. Flat routes keep URLs stable and bookmarkable, matching the existing `/dashboard` etc. links in the vanilla sidebar so users' bookmarks keep working.

**Alternatives.**
- *State-based view switch (no router).* Rejected: breaks back/forward, no deep-linking, URL always stays `/chat`.
- *TanStack Router.* Rejected: more capable but heavier; flat routes don't need it.

### D2: One WebSocket, one store - views subscribe to slices

**Decision.** Keep the existing single `useWebSocket` hook + `useChatStore` (zustand). Add sibling stores: `useDocumentsStore`, `useDashboardStore`, `useHistoryStore`. Each view fetches its REST data on mount and subscribes to relevant WS events (`documents_status` for Documents view, supervisor status poll for Dashboard).

**Rationale.** The WS connection is app-global (one agent session serves all clients). Views shouldn't open their own connections. zustand stores are cheap and already the pattern in `web/`.

### D3: OpenConnector + LiteLLM as iframe wrapper pages

**Decision.** A single `EmbeddedServicePage` component takes `{ title, src }` and renders an `<iframe>` filling the main area. `/openconnector` -> `src="/oc-web"` (the existing token-injecting reverse proxy). `/litellm` -> `src` = the LiteLLM admin URL from `/api/config` (or a `/litellm-web` proxy if same-origin is needed). Gated on enabled state from `/api/config`; shows a "not configured" placeholder if disabled.

**Rationale.** Both services ship their own React/Vue dashboards. Reimplementing would be wasted effort and drift from upstream. The `/oc-web` proxy already exists and injects tokens server-side (preserving "tokens never reach the browser"). Iframe keeps them same-origin where possible.

**Alternatives.**
- *Port OC UI to our React.* Rejected: huge effort, drifts from upstream, violates "third-party project" framing.
- *Open in new tab.* Rejected: loses the shell context, worse UX.

### D4: Dashboard reads supervisor status via a new `/api/supervisor/status` REST route

**Decision.** In dev (`npm start`), there's no Electron supervisor. Add a lightweight `/api/supervisor/status` REST route in `server.js` that returns the server's own health + provider/model + document counts + MCP tool count. In the packaged app, the Electron main process's `registerStatusIpc` already exposes supervisor status; the React app calls the same REST route which, when running under Electron, proxies to the IPC. This keeps the Dashboard view identical in dev and packaged.

**Rationale.** The Dashboard needs *something* to show in dev too. A REST route that works in both modes is simpler than branching the React code per environment.

**Alternatives.**
- *Only show supervisor status in packaged app.* Rejected: dev dashboard would be empty/useless.
- *WebSocket event for supervisor status.* Rejected: it's polled infrequently; REST is simpler and matches the existing `/api/config` pattern.

### D5: Retire `public/` only after every view has a React equivalent + passing e2e

**Decision.** Phase the work: build each React page, port its e2e test, confirm green, THEN delete the vanilla view. `public/` is deleted in a single final commit only after all five views (Documents, Dashboard, Chat History, OpenConnector iframe, LiteLLM iframe) have passing React e2e. `server.js` static-serving collapse (`/` serves `web/dist/`) lands in the same commit.

**Rationale.** Deleting `public/` early would leave the app half-broken. The per-view gate ensures we always have a working app.

### D6: Fix the `.dmg` build by (a) running OC postinstall through `npx tsx`, (b) threading proxy to git/curl, (c) correct python-build-standalone URL

**Decision.** Rewrite `scripts/build-openconnector.js`:
- Thread `http_proxy`/`https_proxy` into the `git clone -c http.proxy=...` and into the `curl` calls explicitly (don't rely on inherited env, because the script clears `NODE_OPTIONS` which can drop proxy).
- Run OC's postinstall and build via `npx tsx <script>.ts` instead of `node <script>.ts` - tsx compiles TS itself and bypasses Node 25's type-stripping path entirely.
- Use `createRequire` correctly (the script is ESM; `require` must be created, not global).

Rewrite `scripts/build-python-litellm.sh`:
- Correct URL: `cpython-3.13.0+20250115-aarch64-apple-darwin.tar.xz` from the `20250115` release (the previous URL 404'd).
- Thread proxy to `curl` via `--proxy`.
- Verify the downloaded archive is >1MB before `tar -xf` (catches the 9-byte-error-page failure mode).

`scripts/verify-bundle.js` already exists from the archived change - it enforces all three resource trees exist before `electron-builder` runs.

**Rationale.** Each of the three failure modes was observed in the previous attempt. tsx is already a dev dependency. The proxy gotcha is documented in the user's global CLAUDE.md.

**Alternatives.**
- *Downgrade Node.* Rejected: the bundled Node is v25 and we want it.
- *Pin OC to a release tarball instead of git clone.* Rejected: OC doesn't publish release tarballs; git clone at a SHA is the pin.

### D7: `npm run predist` is idempotent and cacheable

**Decision.** Both build scripts skip if their target already exists (`resources/openconnector/dist/index.js`, `resources/python/bin/python3`, `resources/litellm/venv/bin/litellm`). This lets a developer rerun `npm run dist` without re-cloning/re-downloading. A `npm run clean:bundle` script nukes `resources/{openconnector,python,litellm}` to force a fresh build.

**Rationale.** The full bundle build takes ~5 min; caching is essential for iteration.

## Risks / Trade-offs

- **Losing vanilla e2e coverage during the port.** -> Keep vanilla `public/` + its e2e tests running until each React equivalent is green (D5). Delete vanilla tests with the vanilla code in the final commit.
- **Iframe same-origin / cookie issues for LiteLLM admin.** -> If the LiteLLM admin UI is on a different origin (`192.168.1.4:4000`), the iframe may refuse to set cookies or frame-ancestors. Mitigation: add a `/litellm-web` reverse proxy in `server.js` (like `/oc-web`) that injects the admin token and rewrites frame-ancestors. Fallback: "open in new tab" link if iframe blocked.
- **React router base path under Electron.** -> `BrowserRouter` uses history API; Electron's `file://`-loaded windows need `HashRouter`. But our window loads `http://localhost:<port>`, so `BrowserRouter` works. Verify in the packaged app.
- **OC build still brittle (upstream postinstall changes).** -> Pin the SHA (already done); if postinstall breaks on a bump, the build script's `npx tsx` path is the documented escape hatch.
- **Bundle size.** -> ~300MB compressed target. If exceeded, tighten `electron-builder.yml` filters (drop more stdlib, OC dev files). Monitor in `verify-bundle.js`.
- **Dashboard REST route exposes internals.** -> `/api/supervisor/status` returns only non-secret fields (states, counts, model id) - never tokens. Same origin as the app; the "tokens never reach browser" invariant holds.
- **Deleting `public/` is irreversible in git history.** -> It's all in git; a revert restores it. The final commit is a clean deletion, no half-states.

## Migration Plan

1. **React router + shell** (D1, D2) - add router, rewire sidebar. Vanilla still served at `/` as fallback.
2. **Port views one at a time** (D5) - Documents -> Dashboard -> Chat History -> OC iframe -> LiteLLM iframe. Each: build page, port e2e, confirm green.
3. **Collapse serving** - `server.js` serves `web/dist/` at `/`; delete `public/`; delete vanilla e2e.
4. **Fix .dmg build** (D6) - rewrite build scripts; run `npm run predist` to populate `resources/`; `npm run dist` produces the `.dmg`.
5. **Verify** - launch `.dmg`, confirm all five views work with bundled OC + LiteLLM (no external services).

**Rollback:** revert the change. `public/` returns. `.env`/`settings.json` pointing at external services still works (the supervisor's resource-presence probe falls back to `http-external`).

## Open Questions

- **Chat History route**: should past sessions be viewable read-only in a dedicated `/history` page, or surfaced as a panel in the Chat view (like the sidebar session list)? The vanilla app has a separate Chat History tab. Recommend a dedicated `/history` page for browsing, plus the sidebar for quick switching.
- **LiteLLM iframe origin**: does the LiteLLM admin UI allow being framed, or do we need a `/litellm-web` reverse proxy? Needs a quick test against the running `192.168.1.4:4000` once it's back up.
- **Dashboard scope**: how much detail? Minimal (server states + model + counts) vs. richer (recent activity, error log tail). Recommend minimal for v1; the supervisor status IPC already exposes log lines if needed later.
