## Context

The LiteLLM page (`web/src/pages/EmbeddedServicePages.tsx` `LiteLLMPage`) embeds the LiteLLM dashboard via an iframe at `/ui`, with server-side auto-login added in `server.js` `proxyLitellmUi`: on `/ui` with no `token` cookie it POSTs `/login`, caches the JWT, and returns a 303 (`Set-Cookie: token=<JWT>` + `Location: /ui/?userID=default_user_id`). The dashboard JS then extracts the virtual `key` from the JWT and sends `Authorization: Bearer <virtual_key>` on its API calls; `createWebProxy`/`proxyLitellmUi` forward that (only injecting the master key when no client Authorization is present).

Four problems remain:
1. The master-key bar at the top of `LiteLLMPage` (surfaces `masterKey` from `/api/litellm/credentials` + a Copy button) is now dead clutter - auto-login means the user never pastes a key.
2. The standalone History nav entry + `/history` route + `ChatHistoryPage` are redundant with the sidebar session list. `app-navigation` already mandates the History tab's removal; the code drifted.
3. **Auto-login race**: `proxyLitellmUi` only does the 303 login when NO `token` cookie is present. When the cookie is already set (from a prior load) but the URL lacks `?userID=` (e.g. the user re-clicks the LiteLLM nav), it forwards to LiteLLM `/ui` -> 307 -> `/ui/` (no `?userID=`) -> the dashboard clears the cookie and bounces to `/sso/key/generate`. Reproduced: any navigation to `/ui` with a stale cookie lands on the login page.
4. **Models view blank through the proxy**: clicking the dashboard's Models nav (which navigates to `?page=models`, a query-param view) renders the Models page on `:4000` directly ("All Models / Add Model / Model Analytics") but NOT through the proxy (stays on Virtual Keys, no model API requests fired). The `/model/info` and `/models` endpoints both return data through the proxy, so this is a client-side navigation/hydration issue, not an API issue.

## Goals / Non-Goals

**Goals:**
- Remove the master-key bar from the LiteLLM page.
- Remove the History nav entry, `/history` route, and `ChatHistoryPage`.
- Make auto-login idempotent: navigating to the LiteLLM view ALWAYS lands on the authenticated dashboard, regardless of prior cookie state.
- Make the embedded dashboard's Models view render identically to the standalone dashboard.

**Non-Goals:**
- Changing the sidebar session-list behavior (it stays the sole session-access surface).
- Changing the `chat-history` persistence/list/resume/switch APIs (untouched).
- Replacing the iframe embedding approach (it works; we're fixing bugs, not redesigning).
- Removing `/api/litellm/credentials` (keep the endpoint; it's just no longer fetched by the UI - design decision below).

## Decisions

### Decision 1: Auto-login is idempotent via a `?userID=`-ensuring redirect
`proxyLitellmUi` SHALL redirect EVERY `/ui` or `/ui/` entry that lacks `?userID=` to `/ui/?userID=<userID>`:
- No `token` cookie -> full login: POST `/login`, cache JWT, return 303 with `Set-Cookie: token=<JWT>` + `Location: /ui/?userID=<userID>`.
- `token` cookie already set -> return 302 with `Location: /ui/?userID=<userID>` (no Set-Cookie).

`<userID>` SHALL be read from the cached session JWT's `user_id` claim (extracted once when the JWT is fetched, stored alongside `litellmUiToken`), not hard-coded. Falls back to the full login flow if the cookie is present but no cached JWT exists yet.

**Why over alternatives:** Hard-coding `default_user_id` works for the admin login but breaks if the login ever returns a different user. Reading from the JWT is robust. A 302 (not 303) for the cookie-already-set case is semantically correct (GET redirect, not a POST result).

### Decision 2: Remove the master-key bar entirely
Delete the `useLitellmCredentials` hook, the master-key bar JSX, and the `Copy` button from `LiteLLMPage`. The page becomes just the `<EmbeddedFrame>` (matching `OpenConnectorPage`'s shape).

Keep `/api/litellm/credentials` server-side (it's cheap, and a future "open in new tab" fallback would need it). Just stop fetching it from the UI.

**Why:** The bar existed only because the dashboard had an interactive sign-in. Auto-login removed that need. Removing the fetch also removes a render-time network round-trip from the page.

### Decision 3: Remove the History nav + page, keep the API
- Delete `web/src/pages/ChatHistoryPage.tsx`.
- Remove the `{ to: "/history", ... }` entry from `NAV_BASE` in `Sidebar.tsx`.
- Remove the `/history` route + `ChatHistoryPage` import from `App.tsx`.
- Leave `/api/chat-history/*` and the WS session-list behavior untouched (the sidebar session list consumes them).

**Why:** The sidebar session list (per `app-navigation`) is the canonical session-access surface. The standalone History page is duplicate UI. This brings the code into compliance with `app-navigation`'s "standalone Chat History tab SHALL be removed" requirement.

### Decision 4: Root-cause the Models view at implementation time via a network diff
The Models-view issue is confirmed proxy-specific (renders on `:4000`, not through the proxy) but the exact failing request is not yet identified. The implementation SHALL:
1. Load the dashboard through the proxy, click Models, capture the full request trace (all requests + statuses + response types).
2. Repeat on `:4000` directly.
3. Diff the two traces to find the request that succeeds on `:4000` but fails/mismatches through the proxy.
4. Fix the proxy (most likely candidates: a `?page=models` RSC/data request hitting the SPA catch-all, a path that needs adding to the LiteLLM proxy routes + catch-all exclusion, or a header the proxy drops).

**Why not fix it now:** The root cause isn't yet pinned down, and writing a fix blind would be guesswork. The diff approach is deterministic and fast. The fix is very likely the same pattern as the existing proxy-path exclusions (`/ui.txt`, `/user/*`, etc.) already in place.

## Risks / Trade-offs

- **[Risk] The 302-on-cookie-present redirect adds a round-trip to every LiteLLM nav activation when a cookie is set.** -> Mitigation: it's a single 302 (no upstream call), negligible latency; the dashboard loads faster than the login page did.
- **[Risk] Reading `userID` from the JWT couples the proxy to LiteLLM's JWT shape.** -> Mitigation: parse defensively; if the claim is missing, fall back to `default_user_id` (the admin login's user). LiteLLM's JWT shape is stable across versions.
- **[Risk] Removing the History page orphans `/api/chat-history/sessions/:id` (full-message view).** -> Mitigation: acceptable - the endpoint stays available; the sidebar session list + chat resume cover the user-facing needs. No spec requires the standalone viewer.
- **[Risk] The Models-view fix may require adding more paths to the SPA catch-all exclusion / Vite proxy, growing the regex.** -> Mitigation: acceptable - same pattern as existing exclusions. Consider (out of scope here) a future refactor that moves LiteLLM proxy routes before the catch-all to avoid the regex entirely.
- **[Risk] createWebProxy auth-forwarding change (already shipped) could regress OpenConnector.** -> Mitigation: already verified OC still works (it sends no client Authorization, so it still gets the injected token). Re-verify after this change.

## Open Questions

- **Models-view root cause**: is it a path hitting the SPA catch-all, a dropped header, or a `?page=models` RSC request mismatch? Resolved by the network diff in Decision 4 during implementation.
- **Should `/api/litellm/credentials` be removed entirely?** Leaning no (keep for a future new-tab fallback), but could be removed if we want zero dead code. Decide during implementation.
