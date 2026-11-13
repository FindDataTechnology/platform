## 1. Auto-login race fix (server.js)

- [x] 1.1 In `proxyLitellmUi`, extract and cache the `user_id` claim alongside `litellmUiToken` (add a `litellmUiUserId` variable; parse it from the JWT payload when the token is fetched in `getLitellmUiToken`).
- [x] 1.2 Change the `/ui` entry handling so EVERY `/ui` or `/ui/` request lacking `?userID=` redirects to `/ui/?userID=<userID>`: if no `token` cookie -> full 303 login (Set-Cookie + Location); if `token` cookie present -> 302 redirect to `/ui/?userID=<userID>` (no Set-Cookie). Fall back to `default_user_id` if `litellmUiUserId` is unset.
- [x] 1.3 Restart the server and verify: clear cookies, load `/litellm` (auto-login 303 -> dashboard); then re-activate the LiteLLM nav (cookie already set) -> 302 -> dashboard, NOT the login page. Repeat rapidly to confirm no login page.

  > **Verified (1.3):** In the 5.3 smoke test, 3 rapid re-clicks on the LiteLLM nav left the iframe on `/ui/?userID=default_user_id` with no login page - race fixed.

## 2. Models view fix (server.js / vite.config.ts)

- [x] 2.1 Through the proxy, load the dashboard, click the Models nav, and capture the FULL request trace (all requests + statuses + response content-types) when navigating to `?page=models`.
- [x] 2.2 Repeat the same click on `:4000` directly (standalone) and capture the trace.
- [x] 2.3 Diff the two traces; identify the request that succeeds on `:4000` but fails/mismatches through the proxy (likely a path hitting the SPA catch-all, a dropped header, or an RSC data request).
- [x] 2.4 Apply the fix (most likely: add the path to the LiteLLM proxy routes + SPA catch-all exclusion regex + `vite.config.ts` proxy, mirroring the existing `/ui.txt`/`/user/*` pattern).
- [x] 2.5 Verify: through the proxy, click Models -> the Models view renders "All Models" / "Add Model" / model rows, matching the standalone dashboard.

  > **Finding (2.1-2.4):** The initial network diff was inconclusive because the Models page *rendered* ("All Models" headers) on full-page load - but the table was EMPTY. Re-investigating the row data revealed the real bug: the dashboard's Models page fetches `/v2/model/info` and `/get/litellm_model_cost_map`, which were NOT in the proxy routes or SPA catch-all exclusion - they hit the SPA catch-all and returned the Platform's `index.html` instead of LiteLLM JSON, so the dashboard couldn't populate the table. Chat still worked because `pi-provider-litellm` talks to LiteLLM directly server-side (master key), not through the browser proxy.
  >
  > **Fix (2.4):** Added `/v2/*` and `/get/*` to the LiteLLM proxy routes (`server.js`), the SPA catch-all exclusion regex (`v2\/|get\/`), and `vite.config.ts` proxy. Verified (2.5): the Models table now shows all models (`glm-5.2`, `doubao-seed-2-0-pro`, `deepseek-v4-pro/flash`, 8 rows).

## 3. Remove master-key bar (web/)

- [x] 3.1 In `web/src/pages/EmbeddedServicePages.tsx`, delete the `useLitellmCredentials` hook, the master-key bar JSX, the `copied` state, and the `copyKey` handler from `LiteLLMPage`. The component becomes just `<main>` + `<EmbeddedFrame src="/ui">` (mirroring `OpenConnectorPage`).
- [x] 3.2 Remove now-unused imports (`useState` if unused, etc.).
- [x] 3.3 Verify the LiteLLM page renders the iframe full-height with no bar above it; confirm `/api/litellm/credentials` is no longer fetched (network tab).
- [x] 3.4 Decide whether to keep `/api/litellm/credentials` server-side (design leans keep) - if keeping, leave the route as-is; if removing, delete the route + handler in `server.js`.

  > **Decision (3.4):** Kept `/api/litellm/credentials` server-side (no UI consumer now, but cheap to keep for a future new-tab fallback). All imports in `EmbeddedServicePages.tsx` remain used (`useEffect`/`useRef`/`useState` by `useConfig` + `EmbeddedFrame`; `cn` by `Placeholder`).

## 4. Remove History nav + page (web/)

- [x] 4.1 Delete `web/src/pages/ChatHistoryPage.tsx`.
- [x] 4.2 In `web/src/components/Sidebar.tsx`, remove the `{ to: "/history", label: "🕘 History", testId: "nav-history" }` entry from `NAV_BASE`.
- [x] 4.3 In `web/src/App.tsx`, remove the `import { ChatHistoryPage }` and the `<Route path="/history" element={<ChatHistoryPage />} />` line.
- [x] 4.4 Verify: the sidebar no longer shows a History tab; navigating to `/history` redirects to `/chat` (the catch-all `*` route); the sidebar session list still works (create/switch/resume sessions).
- [x] 4.5 Run the e2e test `e2e/embedded-views.spec.js` and any history-related tests; update them if they reference the History nav/page.

  > **(4.5):** Updated `e2e/app.spec.js` (removed `nav-history` from the nav-id list + comment), `e2e/helpers.js` (removed `gotoHistory` + comment), and deleted the now-obsolete `e2e/chat-history-react.spec.js`. `e2e/embedded-views.spec.js` had no History references.

## 5. Spec sync + verification

- [x] 5.1 Run `openspec validate litellm-page-polish --strict` (or equivalent) to confirm the delta specs are well-formed.
- [x] 5.2 Restart the server (`node scripts/start.js`) and Vite (`npm run web:dev`); confirm both come up clean.
- [x] 5.3 End-to-end smoke test: LiteLLM page auto-logs in (no master-key bar, no login form), Models view renders, rapid re-clicks stay authenticated; OpenConnector page still works; Chat session list still works.
- [x] 5.4 Confirm no regressions in the SPA catch-all (Platform routes like `/chat`, `/documents`, `/dashboard` still render the React app).

  > **Smoke results (5.3-5.4):** LiteLLM page: `hasKeyBar: false`, auto-login to `/ui/?userID=default_user_id`, no login form. 3 rapid re-clicks on nav-litellm: stayed on the dashboard (no login page) - race fixed. Models view: `isModels: true` ("All Models" renders). OpenConnector: "OOMOL Connect" UI intact. Chat: session-list + New-chat button present. `/chat`, `/documents`, `/dashboard` all render the React SPA. TS: no new diagnostics in changed files (2 pre-existing errors in untouched `DocumentsPage.tsx`/`useDocumentsStore.ts`).
