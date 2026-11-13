## Why

The LiteLLM page was recently made to auto-login and embed the dashboard, but three follow-up problems remain: (1) the master-key bar at the top of the page is now redundant clutter (auto-login means the user never signs in manually), (2) rapid clicks on the LiteLLM nav land on the login page instead of the dashboard, and (3) the dashboard's Models view does not render. Separately, the standalone History nav entry + page is dead weight — the sidebar session list already covers session access, and `app-navigation` already specifies the History tab should be removed (the code drifted out of compliance).

## What Changes

- **Remove the master-key bar** from the LiteLLM page (`EmbeddedServicePages.tsx`). With server-side auto-login the user never pastes a key, so the bar, the `/api/litellm/credentials` fetch, and the copy-to-clipboard affordance are removed.
- **Remove the History nav entry and `/history` route/page.** The sidebar session-list region remains the sole entry point to past sessions. Brings the code into compliance with `app-navigation` (which already mandates the History tab's removal). The underlying `chat-history` persistence/list/resume/switch APIs are untouched.
- **Fix the auto-login race condition.** When the LiteLLM nav is activated while a `token` cookie is already present (from a prior auto-login) but the URL lacks `?userID=`, the proxy forwards to LiteLLM `/ui`, the dashboard clears the cookie, and the user sees the login page. The proxy SHALL ensure every `/ui` entry navigates to `/ui/?userID=<userID>` — performing the full `/login` 303 when no cookie is present, and a plain redirect to `/ui/?userID=<userID>` when the cookie is already set. The userID SHALL be read from the cached session JWT (not hard-coded).
- **Fix models not displaying in the embedded dashboard.** Root cause to be confirmed in design (the `/ui/models` client-side route 404s on full navigation through the proxy; the dashboard's Models nav may rely on a path or RSC request the proxy mishandles). The embedded dashboard SHALL render the Models view identically to the standalone dashboard.
- **Update the `litellm-web` spec** to reflect that the dashboard is now embedded with server-side auto-login (it currently mandates a new-tab link and forbids forwarding the client `Authorization` — both contradicted by the auto-login design and the newer `app-navigation` spec).

## Capabilities

### New Capabilities
<!-- None - this change modifies existing capabilities. -->

### Modified Capabilities
- `litellm-web`: Dashboard is embedded via iframe with server-side auto-login (was: new-tab link). The proxy forwards the dashboard's virtual-key `Authorization` (was: must not forward any client Authorization). The master-key bar is removed. Auto-login SHALL be idempotent (always lands on the authenticated dashboard, regardless of prior cookie state). The embedded dashboard SHALL render the Models view.
- `app-navigation`: Remove the standalone History nav entry and `/history` page (session list in the sidebar remains). Update the canonical tab set to match reality (Chat, Dashboard, Documents, OpenConnector, LiteLLM).

## Impact

- **Code**: `web/src/pages/EmbeddedServicePages.tsx` (remove master-key bar, simplify `LiteLLMPage`), `web/src/components/Sidebar.tsx` (remove History nav item), `web/src/pages/ChatHistoryPage.tsx` (delete), `web/src/App.tsx` (remove `/history` route + import), `web/vite.config.ts` (drop now-unneeded `/history`-related entries if any), `server.js` `proxyLitellmUi` (idempotent auto-login redirect; models-view fix).
- **APIs**: `/api/litellm/credentials` becomes unused by the frontend (keep the endpoint for now, or remove — design will decide). `/api/chat-history/*` unchanged.
- **Specs**: `litellm-web` and `app-navigation` delta specs. `chat-history` is untouched (its persistence/list/resume/switch requirements all remain).
- **Risk**: The auto-login and models fixes touch the LiteLLM reverse proxy, which also serves the OpenConnector embed pattern — changes must not regress OC. The History removal is low-risk (UI-only).
