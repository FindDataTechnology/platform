## 1. React shell: routing + nav

- [x] 1.1 Install `react-router-dom` in `web/`.
- [x] 1.2 Add `<BrowserRouter>` + `<Routes>` in `web/src/main.tsx` or `App.tsx`. Routes: `/chat`, `/documents`, `/dashboard`, `/history`, `/openconnector`, `/litellm`. `/` redirects to `/chat`.
- [x] 1.3 Create `web/src/pages/` dir. Move chat into `pages/ChatPage.tsx`. Stub the other routes with placeholder components so the router works end-to-end.
- [x] 1.4 Rewrite `web/src/components/Sidebar.tsx`: replace `<a href>` with `<Link to>` from react-router. Add `data-testid` to each nav link. Keep the LiteLLM gating on `/api/config`.
- [x] 1.5 Verify nav switches views without a page reload and the WS stays connected (manual + a quick e2e).

## 2. Documents React view

- [x] 2.1 Create `web/src/hooks/useDocumentsStore.ts` (zustand) + `web/src/lib/documents-api.ts` wrapping `/api/documents/*` and `/api/collections/*`.
- [x] 2.2 Build `web/src/pages/DocumentsPage.tsx`: upload (file/text/URL) controls, document list with status badges, source-content pane, per-doc query box. Add `data-testid` hooks (`doc-row`, `doc-status`, `doc-query-input`, etc.).
- [x] 2.3 Build the Collections section in the same page (or a sub-route `/documents/collections`): create, list, detail (member docs + add + delete), collection query.
- [x] 2.4 Subscribe to `documents_status` WS events in the store; update list rows live.
- [x] 2.5 Disabled-state: if `/api/config` reports documents disabled, render the placeholder instead of the upload UI.
- [x] 2.6 Port `e2e/documents.spec.js` + `e2e/uploads-and-collections.spec.js` to target the React `/documents` view via `[data-testid]`. Keep the throwaway store-dir isolation.

## 3. Dashboard React view

- [x] 3.1 Add `/api/supervisor/status` REST route in `server.js` returning non-secret fields only (id, name, kind, state, pid, port, url, restartCount, lastCheck, lastError, recentLogs, currentModel, provider, documentCount, collectionCount, mcpToolCount). Strip every secret key explicitly.
- [x] 3.2 In packaged Electron mode, wire `/api/supervisor/status` to the supervisor's `status()` (the IPC already exposes it). In dev, return server.js's own self-status.
- [x] 3.3 Build `web/src/pages/DashboardPage.tsx`: server rows, model/provider card, counts card, MCP tool count, manual Refresh button, error/retry state.
- [x] 3.4 New `e2e/dashboard.spec.js`: load `/dashboard`, assert `server-js` row + model render, assert the `/api/supervisor/status` response has no secret keys.

## 4. Chat History React view

- [x] 4.1 Create `web/src/hooks/useHistoryStore.ts` + `web/src/lib/chat-history-api.ts` wrapping `/api/chat-history/sessions` and `/api/chat-history/sessions/:id`.
- [x] 4.2 Build `web/src/pages/ChatHistoryPage.tsx`: session list (title + updatedAt), click to view messages read-only. Add `data-testid` hooks.
- [x] 4.3 Port `e2e/chat-history.spec.js` to target the React `/history` view.

## 5. Embedded service views (OpenConnector + LiteLLM)

- [x] 5.1 Build `web/src/pages/EmbeddedServicePage.tsx` taking `{ title, src, enabled }`; renders `<iframe>` filling the main area or a placeholder. Add `data-testid="embedded-iframe"`.
- [x] 5.2 `/openconnector` route uses `src="/oc-web"` and `enabled` from `/api/config.openconnectorEnabled`.
- [x] 5.3 `/litellm` route: try `src` = LiteLLM admin URL. If framing is blocked, add a `/litellm-web` reverse proxy in `server.js` (mirror `/oc-web`) that injects the admin token; fall back to an "Open in new tab" link if still blocked.
- [x] 5.4 New `e2e/embedded-views.spec.js`: stub `/api/config` for enabled + disabled states; assert iframe present/absent on `/openconnector` and `/litellm`.
- [x] 5.5 New `e2e/nav-persistence.spec.js`: navigate `/chat` -> `/documents` -> `/chat` via sidebar; assert no page reload and WS stays connected.

## 6. Retire vanilla frontend

- [x] 6.1 Confirm every vanilla view has a green React e2e equivalent (Documents, Dashboard, Chat History, OC iframe, LiteLLM iframe).
- [x] 6.2 Collapse `server.js` static serving: serve `web/dist/` at `/` + `/assets/*`. Remove the `/` -> `/chat/` redirect. Remove the `public/` static mount.
- [x] 6.3 Delete `public/` directory (`app.js`, `index.html`, `style.css`).
- [x] 6.4 Delete vanilla-specific e2e specs that have no React equivalent or are fully superseded. Update `playwright.config.js` if needed.
- [x] 6.5 Run full `npm run test:e2e` green.

## 7. Fix the .dmg self-contained bundle build

- [x] 7.1 Rewrite `scripts/build-openconnector.js`: use `createRequire(import.meta.url)` correctly; thread `http_proxy`/`https_proxy` into `git clone -c http.proxy=...`; run OC postinstall + build via `npx tsx scripts/*.ts` to bypass Node 25 type-stripping; keep the cache-skip if `resources/openconnector/dist/index.js` exists.
- [x] 7.2 Rewrite `scripts/build-python-litellm.sh`: correct python-build-standalone URL (`cpython-3.13.0+20250115-aarch64-apple-darwin.tar.xz` from release `20250115`); thread proxy to `curl --proxy`; verify downloaded archive > 1MB before `tar -xf`; create venv + `pip install "litellm[proxy]==<pin>"`; strip `__pycache__`.
- [x] 7.3 Confirm `scripts/verify-bundle.js` enforces `resources/openconnector/dist/index.js` + `resources/python/bin/python3` + `resources/litellm/venv/bin/litellm` exist before electron-builder runs.
- [x] 7.4 Add `npm run clean:bundle` script to nuke `resources/{openconnector,python,litellm}` for a forced rebuild.
- [x] 7.5 Run `npm run predist` end-to-end and confirm all three resource trees populate (no 9-byte error pages, no type-stripping crashes).
- [x] 7.6 Run `npm run dist` and confirm `dist/Platform-<ver>-arm64.dmg` is produced and > 150MB.

## 8. .dmg verification (manual)

- [ ] 8.1 Mount `dist/Platform-<ver>-arm64.dmg`, drag Platform to /Applications, launch.
- [ ] 8.2 Confirm first-run bootstrap seeds `settings.json` + OC tokens + `litellm.yaml` (check `~/Library/Application Support/Platform/`).
- [ ] 8.3 Confirm all four bundled services come up: server-js, pi-agent (in-process), openconnector (spawned, random port), litellm (spawned, random port) - via the Dashboard view.
- [ ] 8.4 Confirm Chat works (Volces fallback key), model selector shows LiteLLM-routed Volces models, OpenConnector panel loads the native UI, Documents upload + query works.
- [x] 8.5 Confirm compressed `.dmg` <= 300MB; if larger, tighten `electron-builder.yml` `extraResources` filters and rebuild.

## 9. Docs + cleanup

- [x] 9.1 Update `CLAUDE.md` Architecture section: remove the "vanilla `public/` still runs at `/`" note; document the single React SPA + router; document the fixed bundle build (`npm run predist` + `npm run dist`).
- [x] 9.2 Update `web/README.md` with the new route table and page structure.
- [ ] 9.3 `openspec sync` after archiving to merge deltas into `openspec/specs/`.
