## Why

paas currently has no interactive login: `AUTH_MODE=forward_auth` trusts proxy-injected identity headers, which requires deploying a separate oauth2-proxy + reverse-proxy layer. The operator already runs Logto (`auth.finddatatech.cloud`) for the mcp-gateway-registry and wants paas users to log in directly — with group-based visibility (registry market, agent catalog roles) driven by the same Logto identities, and a foundation for follow-up work (per-user preferences, per-user credentials/OBO to the gateway).

The app ships both as a web deployment and as packaged Windows/macOS desktop apps, and both form factors must carry the same Logto identity: sibling apps (already Logto-fronted) and upcoming services (sub2api) relate to paas the way MCP servers and skills do today — shared user identity only, no machine-to-machine delegation for now.

## What Changes

- **New `AUTH_MODE=logto`**: native OIDC authorization-code login against Logto. Unauthenticated browser requests are redirected to Logto's hosted sign-in (via a local `/auth/login` initiator); the callback exchanges the code and establishes a server-side session cookie.
- **Session infrastructure**: signed, HttpOnly session cookie (`paas_session`) holding the identity (email, groups); constant-time signature verification; logout route clears it. No server-side session store — the cookie is self-contained (HMAC), stateless like the rest of the server.
- **Identity mapping**: `email` from the ID token; `groups` from Logto `organizations`/`organization_roles` claims (requested via `urn:logto:scope:organizations`), normalized to the same `{email, groups}` shape forward-auth produces — so agent-catalog `roles` visibility, `requireAdmin`, the registry market group filter, and personal runtime bindings all work unchanged.
- **Reuses the SSO UX that already shipped** (the `auth` capability): the `/login` page and Settings → Account sign-out navigate to server-provided URLs, so `logto` mode only supplies different `loginUrl`/`logoutUrl` values — no new web surfaces.
- **WS upgrade gating**: WebSocket upgrades validate the session cookie identically to HTTP requests.
- **Config via discovery**: OIDC metadata fetched from `LOGTO_ENDPOINT`; client id/secret from existing `LOGTO_APP_ID`/`LOGTO_APP_SECRET` env; redirect URI derived from the request Host (configurable via `PAAS_BASE_URL`).
- **Desktop (Electron) parity**: the packaged app runs its local `server.js` with the same `logto` mode against a second Logto application registered as a **public client (PKCE, S256)** — no client secret ships in the installer. The supervisor binds a fixed loopback port (`DESKTOP_SERVER_PORT`, default 47600, exclusive bind with a visible error on conflict) so the redirect URI `http://127.0.0.1:47600/auth/callback` is registerable in the Logto console. Login is mandatory on desktop; the session TTL defaults to 30 days with sliding renewal, so app restarts and normal use do not force re-login (a fresh login still needs network access to Logto).
- **Unchanged**: `AUTH_MODE` unset (open access), `forward_auth`, and the optional-SSO overlay keep behaving exactly as before; bot webhook exemptions stay.

## Capabilities

### New Capabilities

- `logto-auth`: native Logto OIDC login mode — redirects, callback exchange, session cookie issuance/verification, WS gating, identity mapping, logout.

### Modified Capabilities

- `forward-auth`: "Opt-in authentication mode" declares the third mode (`logto`) and states injected headers are not consumed in it.
- `auth`: "Public identity and SSO configuration" extends the `/api/auth/me` contract to `logto` mode (`authenticated` for cookie sessions; mode-specific `loginUrl`/`logoutUrl`).
- `desktop-supervisor`: "Port management for spawned servers" gains the fixed-port option (exclusive bind, visible failure on conflict) and auth-env injection from the packaged settings file.

## Impact

- **Server**: new `server/logto-auth.js` + `server/session.js`; `server/auth.js` gate gains the `logto` branch (redirect browser / 401 API / attach `req.user`); `server/ws.js` cookie verification; `server/routes/misc.js` `/api/auth/me` mode-aware fields. `server/logto-auth.js` branches on `LOGTO_CLIENT_TYPE=public` (PKCE challenge, secret-less exchange) for the desktop client.
- **Desktop**: `supervisor/` fixed-port path for `server-js` (`DESKTOP_SERVER_PORT`, no silent random fallback when set); `electron/config/settings.js` bundled defaults inject `AUTH_MODE=logto`, `LOGTO_ENDPOINT`, public `LOGTO_APP_ID`, `LOGTO_CLIENT_TYPE=public`, `SESSION_TTL_HRS=720` into the `server-js` child environment.
- **Web**: none new — the existing `/login` page and account sign-out consume the server-provided URLs and work under `logto` mode as-is (verification task only).
- **Config**: new env — `AUTH_MODE=logto`, optional `PAAS_BASE_URL`, `SESSION_SECRET` (auto-generated + persisted to `PLATFORM_DATA_DIR` if absent), `SESSION_TTL_HRS`, `LOGTO_END_SESSION`, `LOGTO_CLIENT_TYPE` (`confidential` default | `public`), `DESKTOP_SERVER_PORT` (packaged app only). Existing `LOGTO_ENDPOINT`/`LOGTO_APP_ID`/`LOGTO_APP_SECRET` reused (secret unused in public mode).
- **Operator prerequisite (Logto console, one-time)**: register **two** applications — (a) a traditional-web app for the deployment with redirect URI `https://<paas-host>/auth/callback`, and (b) a public (native/SPA) app for the desktop builds with redirect URI `http://127.0.0.1:47600/auth/callback`; enable organizations/custom claims so the ID token carries `organizations`/`organization_roles`. Documented in `.env.example`/README.
- **Dependencies**: none new — OIDC discovery + code exchange implemented with `fetch` and `node:crypto` (HMAC-SHA256 cookie signing, JWKS signature verify).

