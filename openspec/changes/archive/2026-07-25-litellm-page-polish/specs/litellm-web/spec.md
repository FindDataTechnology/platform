## MODIFIED Requirements

### Requirement: Server reverse-proxies the LiteLLM management UI with token injection
When LiteLLM is configured (`LITELLM_BASE_URL` and `LITELLM_API_KEY` set), the server SHALL mount a reverse proxy that forwards the LiteLLM dashboard (served at `/ui` and `/ui/*`) and its root-level API/asset paths to the configured LiteLLM base URL, forwarding the request method, body, and query string. The proxy SHALL forward the client's `Authorization` header when present (the embedded dashboard extracts a virtual key from its session JWT and sends it as a Bearer token; this is required so `/user/info` authenticates as the session user rather than returning `user_id: null`). When the client sends no `Authorization` (e.g. the application's own server-side calls), the proxy SHALL authenticate to LiteLLM using the server-held `LITELLM_API_KEY` as a bearer token. The proxy SHALL forward the client's `token` session cookie so endpoints that read the cookie authenticate correctly. The proxy SHALL constrain upstream requests to the configured LiteLLM base URL. Content-encoding and content-length SHALL NOT be forwarded (Node's fetch decompresses the body; express recomputes length).

#### Scenario: dashboard's virtual-key Authorization is forwarded
- **WHEN** the embedded LiteLLM dashboard sends a request to `/user/info` with `Authorization: Bearer <virtual_key>` (extracted from its session JWT)
- **THEN** the server SHALL forward that `Authorization` header to LiteLLM
- **AND** LiteLLM SHALL authenticate as the session user (non-null `user_id`)

#### Scenario: server-held key injected when no client Authorization
- **WHEN** the application makes a server-side call to a LiteLLM proxied path with no client `Authorization` header
- **THEN** the server SHALL authenticate to LiteLLM using the server-held `LITELLM_API_KEY`

#### Scenario: token cookie forwarded
- **WHEN** the embedded dashboard sends a request with a `token` session cookie
- **THEN** the server SHALL forward the cookie to LiteLLM

### Requirement: LiteLLM SPA absolute API paths are proxied at the root
Because the LiteLLM management UI is a SPA that issues same-origin absolute requests for its API and assets, the server SHALL proxy the SPA's non-conflicting roots (`/ui` and `/ui/*` verbatim, `/key/*`, `/spend/*`, `/model/*`, `/models`, `/user/*`, `/v2/*`, `/get/*`, `/get_image`, `/get_favicon`, `/sso/*`, `/login`, `/logout`, `/litellm-asset-prefix/*`) at the server root to the LiteLLM base URL whenever LiteLLM is configured, and the contested roots (`/v1/*` and a `/api/*` catch-all) ONLY when the OpenConnector module is not enabled. The `/api/*` catch-all SHALL be registered after the application's own `/api/*` routes so those take precedence. These paths SHALL also be excluded from the application's SPA catch-all (which would otherwise serve the React app's `index.html` and break dashboard hydration); the `/ui` exclusion SHALL match any path beginning with `/ui` (including `/ui.txt?_rsc=` Next.js RSC probes) so they reach LiteLLM rather than the SPA.

#### Scenario: non-conflicting root proxied whenever LiteLLM is configured
- **WHEN** the embedded LiteLLM UI requests an absolute path such as `/key/info`, `/model/info`, `/v2/model/info`, `/user/info`, `/models`, `/get/litellm_model_cost_map`, or `/get_image`
- **THEN** the server SHALL proxy it to the LiteLLM base URL, whether or not OpenConnector is enabled

#### Scenario: dashboard Models page populates through the proxy
- **WHEN** the embedded dashboard's Models view fetches `/v2/model/info` and `/get/litellm_model_cost_map`
- **THEN** the server SHALL proxy them to LiteLLM and return JSON (not the React app's `index.html`)
- **AND** the Models table SHALL render the configured models

#### Scenario: Next.js RSC probe does not hit the SPA catch-all
- **WHEN** the embedded dashboard requests `/ui.txt?_rsc=<token>`
- **THEN** the server SHALL proxy it to LiteLLM (which returns 404) rather than serving the React app's `index.html`

#### Scenario: contested root proxied only when OpenConnector is disabled
- **WHEN** the embedded LiteLLM UI requests `/v1/models` and OpenConnector is disabled
- **THEN** the server SHALL proxy it to the LiteLLM base URL

#### Scenario: app's own API routes take precedence over the catch-all
- **WHEN** the browser requests `/api/documents` or `/api/config`
- **THEN** the server SHALL route it to the application's own handler, not the LiteLLM proxy

## REMOVED Requirements

### Requirement: LiteLLM view links to the management UI in a new tab
**Reason**: The dashboard is now embedded in a same-origin iframe with server-side auto-login (see the added "LiteLLM view embeds the management UI with server-side auto-login" requirement). The new-tab link and its rationale (that the server-side proxy "cannot satisfy" the sign-in flow) are obsolete - the proxy now performs the login server-side.
**Migration**: The LiteLLM sidebar entry switches the main content area to an embedded iframe view at `/ui`; no `target="_blank"` link is rendered. The `litellmManagementUrl` field remains in `/api/config` but is no longer used as a link target by the UI.

## ADDED Requirements

### Requirement: LiteLLM view embeds the management UI with server-side auto-login
The LiteLLM sidebar entry SHALL switch the main content area to a view that embeds the LiteLLM management dashboard in a same-origin `<iframe>` whose `src` is `/ui`. The server SHALL auto-login the embedded session: when the iframe requests `/ui` (or `/ui/`) with no `token` cookie, the server SHALL POST `/login` to LiteLLM with username `admin` and the server-held `LITELLM_API_KEY`, cache the returned session JWT, and return a 303 response with `Set-Cookie: token=<JWT>` and `Location: /ui/?userID=<userID>`. The `<userID>` SHALL be read from the cached JWT's `user_id` claim. The UI SHALL NOT render a master-key bar or any sign-in credential affordance; the user SHALL NOT be required to manually authenticate to the embedded dashboard.

#### Scenario: first visit auto-logs in
- **WHEN** the user activates the LiteLLM view with no prior `token` cookie
- **THEN** the server SHALL return a 303 that sets the `token` cookie and redirects to `/ui/?userID=<userID>`
- **AND** the iframe SHALL load the authenticated dashboard without a login form

#### Scenario: no master-key bar is rendered
- **WHEN** the LiteLLM view is displayed
- **THEN** the UI SHALL NOT render a master-key bar, credential display, or copy-to-clipboard affordance above the iframe

### Requirement: Auto-login is idempotent across navigations
The server SHALL ensure that every navigation to `/ui` or `/ui/` that lacks a `?userID=` query parameter redirects to `/ui/?userID=<userID>` before serving the dashboard, regardless of prior cookie state. When a `token` cookie is already present, the server SHALL issue a 302 redirect to `/ui/?userID=<userID>` (without re-performing the `/login` POST). When no `token` cookie is present, the server SHALL perform the full auto-login 303. This prevents the dashboard from clearing the cookie and bouncing to the login page on re-navigation.

#### Scenario: re-navigation with existing cookie stays authenticated
- **WHEN** the user activates the LiteLLM view again while a `token` cookie is already set and the request URL lacks `?userID=`
- **THEN** the server SHALL redirect to `/ui/?userID=<userID>` (302)
- **AND** the iframe SHALL load the authenticated dashboard, NOT the login page

#### Scenario: rapid repeated activations never show the login page
- **WHEN** the user clicks the LiteLLM nav entry repeatedly in quick succession
- **THEN** the iframe SHALL always land on the authenticated dashboard
- **AND** SHALL NOT show the `/sso/key/generate` login page

### Requirement: Embedded dashboard renders all management views identically to standalone
The embedded LiteLLM dashboard SHALL render every management view (Virtual Keys, Models, Usage, Teams, etc.) identically to the standalone dashboard accessed directly at the LiteLLM base URL. The proxy SHALL NOT cause any management view to fail to render, show empty content, or make fewer API requests than the standalone dashboard. In particular, the Models view (navigated via the dashboard's `?page=models` query-param nav) SHALL render the models list with "All Models" / "Add Model" / model rows, matching the standalone dashboard.

#### Scenario: Models view renders through the proxy
- **WHEN** the user clicks the Models nav in the embedded dashboard
- **THEN** the Models view SHALL render the models list (e.g. "All Models", "Add Model")
- **AND** the view SHALL match the standalone dashboard's Models view rendered at the LiteLLM base URL directly
