## Context

Auth recently grew two layers (landed separately): `server/auth.js` now distinguishes public routes (`/api/auth/me`, `/login`, static shell), the `forward_auth` gate, and an optional-SSO overlay (`req.ssoUser`) for auth-disabled mode; the web side ships a `/login` page and a Settings → Account sign-out that navigate to server-provided `loginUrl`/`logoutUrl` from `/api/auth/me`. All of it is **oauth2-proxy-header based** — no interactive login exists without deploying that proxy layer. Separately, `user-runtime-bindings` keys personal model/MCP preferences off a server-derived identity. The operator's Logto tenant (`auth.finddatatech.cloud`) is live and OIDC-discoverable (issuer `https://auth.finddatatech.cloud/oidc`, verified) and already fronts the mcp-gateway-registry. Identity consumers — catalog `roles`, `requireAdmin`, registry market group filter, runtime bindings — all read `{email, groups}` off `req.user`/`ws.user`, so a login mode producing that shape slots in without touching consumers, and Logto users immediately get personal bindings.

The product ships two form factors that both need the same identity: the k8s web deployment, and packaged Windows/macOS desktop apps. The desktop app is an Electron main process supervising a local `server.js` child (`supervisor/lifecycle.js`) with a BrowserWindow pointed at `http://localhost:<port>` — meaning the desktop can run the identical server-side login flow against its own local server. Ecosystem direction: sibling apps already log in via the same Logto tenant and will relate to paas the way MCP servers and skills do; sub2api joins later. Scope confirmed as **shared user identity only** (no machine-to-machine API auth, no token delegation).

## Goals / Non-Goals

**Goals:**
- One new mode, zero behavior change for the other two (`none`, `forward_auth`).
- Identity shape parity: `{email, groups}` identical to forward-auth output so `agent-catalog`/`requireAdmin`/market filtering work unchanged.
- Stateless server: self-contained signed cookie, no session table.
- No new runtime dependencies (fetch + node:crypto only).
- Desktop parity: packaged apps log in through the same code path, with no client secret in the installer, mandatory login, and sessions that survive normal use/restarts.

**Non-Goals:**
- Per-user MCP credentials / OBO token pass-through to the registry gateway (the "配套优化" follow-ups build on this identity, but are separate changes).
- RBAC beyond existing groups checks; user provisioning flows; Logto Management API automation (redirect-URI registration is a documented console step).
- Machine-to-machine auth for paas APIs (bots already have their own exemption + signing).
- System-browser handoff for desktop login (custom scheme / one-time-code bridge). The in-app window completes the OIDC chain because the local server serves the callback; this is revisited only if a webview-hostile social connector (e.g. Google) becomes a primary desktop sign-in method.

## Decisions

### D1: New mode `AUTH_MODE=logto`, integrated into the existing gate
A single `server/logto-auth.js` exports the redirect/callback/logout routes plus a `verifyRequest(req)` used by the existing middleware in `server/auth.js`: under `logto` mode the gate's flow becomes public-path → valid cookie (`req.user` attached) → browser redirect to `/auth/login` / 401 for JSON APIs. The optional-SSO overlay (`req.ssoUser`) is orthogonal and untouched. Why not a library (openid-client)? Zero-dep policy for the server so far; the flow needed (confidential client, code exchange, JWKS verify) is small and `node:crypto` covers it (RS256/ES256 via Logto's published JWKS).

### D2: Self-contained HMAC cookie, not server-side sessions
Cookie payload = base64url(JSON `{email, groups, exp, nonce}`) + `.` + HMAC-SHA256. Secrets: `SESSION_SECRET` env or auto-generated and persisted under `PLATFORM_DATA_DIR/auth/session-secret` (0600) on first boot. Why not SQLite sessions: the server's auth state today is stateless per-request; a table adds expiry sweeps for no gain at team scale (~dozens of users). Trade-off accepted: logout cannot revoke a stolen cookie server-side — mitigation is short-ish TTL (`SESSION_TTL_HRS`, default 24) and HttpOnly/SameSite=Lax.

### D3: Groups from Logto organizations + role short names
Logto has no native `groups`; it has organizations and organization roles. The ID token carries `organizations: [orgId…]` and `organization_roles: ["<orgId>:<roleName>"]` when the token requests `urn:logto:scope:organizations`. Mapping: `groups = organizations ∪ {roleName for each organization_role}` — e.g. org `finddata`, role `finddata:admin` → `["finddata", "admin"]`. This keeps `requireAdmin` (checks `groups.includes("admin")`) working with a Logto role literally named `admin`. Operators tune group names by naming Logto orgs/roles to match catalog `roles` entries (same convention as the registry's `group_mappings`). Alternative rejected: `roles` scope (personal roles) — organization roles are how the operator already models teams in Logto.

### D4: Redirect URI derived from Host; `PAAS_BASE_URL` override
`redirect_uri = ${PAAS_BASE_URL || request scheme+host}/auth/callback`. Behind the cluster's Caddy TLS termination the Host header is preserved, so deriving from the request keeps localhost dev and cluster deploy working without config. Known gap: if the deployment sits behind host-rewriting proxies without forwarded headers, the operator sets `PAAS_BASE_URL`. State+nonce: random per login, stored in short-lived signed cookies (`paas_oauth_state`, 10 min) — no server-side store needed.

### D5: WS gating via cookie parse, shared verifier
`server/ws.js` currently gates on `userFromHeaders`. For `logto` mode it parses the `paas_session` cookie from the upgrade request headers through the same verifier and sets `ws.user`. One verifier module (`verifySessionCookie`) shared by HTTP middleware and WS gate so semantics cannot drift. `switchableAgents(ws.user)` then serves role-filtered catalogs on the socket unchanged.

### D6: Web surfaces reused, not rebuilt
The shipped `/login` page and Settings → Account sign-out already navigate to the server-provided `loginUrl`/`logoutUrl` (the `auth` capability's contract). Under `logto` mode the server reports `loginUrl: "/auth/login"` (local initiator that 302s to Logto) and `logoutUrl: "/api/auth/logout"`; the existing UI therefore works unchanged. Only verification work: the login page renders under `logto`, sign-out returns to a logged-out state, and the account surface shows the Logto email.

### D7: Config and failure matrix
`LOGTO_ENDPOINT` (exists), `LOGTO_APP_ID`/`LOGTO_APP_SECRET` (exist), `AUTH_MODE=logto`, optional `PAAS_BASE_URL`, `SESSION_SECRET`, `SESSION_TTL_HRS=24`, `LOGTO_END_SESSION=false`. Discovery fetch failure at boot ⇒ fail fast with a clear error (auth misconfiguration must not silently open the app). Token exchange/verify failures ⇒ redirect to `/` with `?auth_error=…`, logged server-side. The console prerequisite (redirect URI registration + organizations scope on the Logto app) is documented in `.env.example` and the README operator section.

### D8: Desktop login runs in the app window, no system-browser bridge
The Electron window is Chromium and the local `server.js` serves `/auth/callback` itself, so the desktop flow is the web flow verbatim: window loads `http://127.0.0.1:<port>/` → 302 to Logto's hosted sign-in (email + password; Logto owns all sign-in methods) → 302 back to the local callback → cookie lands on `127.0.0.1` in the window's session jar. No custom protocol handler, no one-time-code handoff, no shell.openExternal dance. Accepted limitation: a social connector that refuses embedded webviews (Google's `disallowed_useragent`) would not work in-app; the tenant's email+password flow is the target method, and the system-browser pattern remains the documented fallback if that ever changes.

### D9: Two Logto applications — web confidential, desktop public PKCE
A confidential client requires `LOGTO_APP_SECRET`, which cannot ship inside a distributed installer (trivially extracted, shared by all installs). The console therefore registers two applications against the same tenant: a **traditional-web app** for the k8s deployment (secret stays server-side in env) and a **public app** (native/SPA type) for the desktop builds. `server/logto-auth.js` branches on `LOGTO_CLIENT_TYPE=public`: the authorize URL additionally carries `code_challenge`/`code_challenge_method=S256` (verifier sealed alongside state in the signed `paas_oauth_state` cookie), and the token exchange omits `client_secret`. Same discovery, JWKS verify, session issuance, and identity mapping — one branch point, no duplicated flow. Console verification step: confirm the chosen public app type accepts the loopback redirect URI `http://127.0.0.1:47600/auth/callback` (Logto permits http on loopback for dev/native-style apps; if the app type rejects it, register the native type with the same flow).

### D10: Fixed desktop port, exclusive bind
Logto matches redirect URIs exactly, and the desktop supervisor currently picks a random free port — unregistrable. The supervisor already accepts a fixed `serverPort` (`supervisor/lifecycle.js`, `fixedServerPort || findFreePort()`); the packaged app passes `DESKTOP_SERVER_PORT` (default 47600) and, when set, the supervisor SHALL bind exclusively: bind failure surfaces as a visible backend-start error (the existing error window) rather than silently falling back to a random port that would break login with a confusing redirect mismatch. Dev runs without the variable keep today's random-port behavior.

### D11: Mandatory desktop login, long sliding session
Desktop bundles default `AUTH_MODE=logto` (mandatory — the "continue anonymous" affordance in the `/login` page only renders under `mode: "none"`, so it disappears automatically) with `SESSION_TTL_HRS=720` (30 days) versus the web's 24. The auth middleware re-signs (slides) the cookie whenever remaining TTL drops below half, so an actively used desktop app never hits re-login; Electron's persistent default session keeps the cookie across app restarts. Offline story: the app stays usable while the session is valid; a fresh login needs network to Logto — accepted cost of mandatory login on a local app.

## Risks / Trade-offs

- [Logto apps not yet registered for paas] → first-run redirect fails at Logto with an app-config error until the operator registers both applications (web: `https://<host>/auth/callback`; desktop public: `http://127.0.0.1:47600/auth/callback`) and enables organizations claims; fail-fast keeps the cause visible.
- [Logout is client-side only] → stolen-cookie revocation requires rotating `SESSION_SECRET` (restart) — acceptable at team scale; noted in docs.
- [Custom claims may be needed if orgs/roles are absent from the ID token by default] → Logto supports custom JWT claims; D3's mapping reads standard org claims requested via scope, with the README documenting the console switch to enable them on access/ID tokens.
- [e2e hermetic mode] → tests keep running with `AUTH_MODE` unset; the logto path is covered by unit tests (state/cookie/verify round-trip with a stubbed discovery+token endpoint) rather than Playwright.
- [Desktop offline] → a fresh login requires reaching Logto; sessions (30-day sliding cookie, persistent Electron session jar) keep the app usable between logins. Accepted cost of mandatory login (D11).
- [Fixed desktop port conflict] → another process on 47600 blocks startup with a visible error instead of a silent random-port fallback (D10); operator/user resolution is documented (change `DESKTOP_SERVER_PORT` + matching Logto redirect URI).
- [Public-client app type vs loopback URI] → if Logto's console rejects `http://127.0.0.1:<port>` on the first-chosen public app type, register the native type instead (D9); verified as a console step before packaging.

## Migration Plan

Web: set `AUTH_MODE=logto` + register the web redirect URI in the Logto console, restart. Desktop: register the public app with the loopback redirect URI, rebuild installers (bundled settings now carry the logto env + `DESKTOP_SERVER_PORT`), redistribute. Rollback: unset `AUTH_MODE` (back to open) — no data migration, cookies simply go unused. `forward_auth` deployments are untouched.

## Open Questions

- None blocking; Logto console steps (redirect URI + org claims enablement) are operator actions documented in the change.
