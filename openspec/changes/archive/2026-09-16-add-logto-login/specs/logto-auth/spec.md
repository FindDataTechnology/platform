## Purpose

Native Logto OIDC login for paas: when `AUTH_MODE=logto`, browsers authenticate against the operator's Logto tenant via authorization-code flow, and the server issues a self-contained signed session cookie. Identity (email + groups mapped from Logto organizations/roles) feeds the existing roles/visibility infrastructure unchanged.

## ADDED Requirements

### Requirement: Logto mode redirects unauthenticated browsers to Logto sign-in
When `AUTH_MODE=logto`, the server SHALL redirect unauthenticated HTML/browser requests to the Logto authorization endpoint (discovered from `LOGTO_ENDPOINT`) carrying `client_id`, `redirect_uri` (derived from the request Host, overridable via `PAAS_BASE_URL`), `response_type=code`, `scope` (openid, profile, email, organizations), `state`, and `nonce`. Authenticated requests and exempt paths (bot webhooks, the auth routes themselves, static login assets) proceed normally. `AUTH_MODE` unset/`none` and `forward_auth` behavior SHALL be unchanged.

#### Scenario: anonymous browser request redirects to Logto
- **WHEN** `AUTH_MODE=logto` and a request without a valid session cookie asks for the app shell
- **THEN** the server responds `302` to the Logto authorization endpoint with state and nonce parameters

#### Scenario: authenticated request proceeds
- **WHEN** a request carries a valid `paas_session` cookie
- **THEN** the handler runs with `req.user = { email, groups }` derived from the session

#### Scenario: open mode unchanged
- **WHEN** `AUTH_MODE` is unset or `none`
- **THEN** no redirect, cookie check, or identity requirement applies, exactly as before

### Requirement: Callback exchanges the code and issues a session cookie
The server SHALL expose `GET /auth/callback`: it validates `state` against the value issued with the redirect, exchanges the code at the token endpoint using the client secret, verifies the ID token (issuer, audience, nonce), maps `email` and `organizations`/`organization_roles` claims to `{email, groups}`, and sets an HttpOnly, SameSite=Lax, signed `paas_session` cookie (HMAC-SHA256 with `SESSION_SECRET`, auto-generated and persisted under `PLATFORM_DATA_DIR` when absent), then redirects to `/`. Invalid state, token exchange failure, or verification failure SHALL redirect to `/` with an error indicator, never a 500 stack.

#### Scenario: successful login
- **WHEN** the user completes Logto sign-in and Logto redirects to `/auth/callback` with a valid code and matching state
- **THEN** the server sets the signed session cookie and redirects to `/`
- **AND** `/api/auth/me` subsequently reports the user's email and groups

#### Scenario: tampered state is rejected
- **WHEN** the callback arrives with a `state` that was not issued by this server
- **THEN** no cookie is set and the user is redirected to `/` with an error indicator

#### Scenario: groups derive from organizations
- **WHEN** the ID token carries `organizations: ["finddata"]` and `organization_roles: ["finddata:admin"]`
- **THEN** the session identity is `{ email, groups: ["finddata", "admin"] }` (org names plus role short names), compatible with catalog `roles` and `requireAdmin`

### Requirement: WebSocket upgrades require a valid session
When `AUTH_MODE=logto`, WebSocket upgrade requests SHALL present the valid `paas_session` cookie; the server derives `ws.user` from it identically to HTTP handlers. Upgrades without a valid cookie SHALL be rejected.

#### Scenario: WS upgrade with session cookie
- **WHEN** the browser opens the WebSocket with the session cookie present
- **THEN** the upgrade succeeds and `ws.user` carries the session identity

#### Scenario: WS upgrade without session
- **WHEN** an upgrade request arrives without a valid session cookie
- **THEN** the upgrade is rejected

### Requirement: Desktop public-client (PKCE) flow
When the server runs with `LOGTO_CLIENT_TYPE=public` (the packaged desktop app's configuration), the authorization redirect SHALL additionally carry an S256 `code_challenge` with the verifier sealed alongside `state`/`nonce` in the signed `paas_oauth_state` cookie, and the token exchange SHALL omit `client_secret`. The flow otherwise uses the same discovery, ID-token verification, identity mapping, and session cookie as the confidential client. The packaged desktop app SHALL default to `AUTH_MODE=logto` with the fixed loopback redirect URI `http://127.0.0.1:<DESKTOP_SERVER_PORT>/auth/callback` and a long session TTL (`SESSION_TTL_HRS=720`); login is mandatory (the anonymous-continue affordance renders only under `mode: "none"`).

#### Scenario: public-client authorize URL carries PKCE
- **WHEN** `LOGTO_CLIENT_TYPE=public` and a login is initiated
- **THEN** the authorization URL includes `code_challenge` and `code_challenge_method=S256`
- **AND** the token exchange succeeds without a client secret

#### Scenario: secret-less configuration boots
- **WHEN** the desktop server starts with `LOGTO_APP_ID` set, `LOGTO_APP_SECRET` unset, and `LOGTO_CLIENT_TYPE=public`
- **THEN** login works end-to-end (no missing-secret failure)

#### Scenario: confidential path unchanged
- **WHEN** `LOGTO_CLIENT_TYPE` is unset or `confidential`
- **THEN** the authorize URL carries no PKCE parameters and the token exchange sends `client_secret`, exactly as before

#### Scenario: desktop session survives app restart
- **WHEN** the desktop app restarts while the session cookie is within its TTL
- **THEN** the user remains authenticated without re-login

### Requirement: Session cookies slide on use
The auth middleware SHALL re-issue (slide) a valid `paas_session` cookie whose remaining lifetime has fallen below half the configured TTL, so actively used sessions do not expire mid-use. Fresh cookies SHALL be returned untouched.

#### Scenario: near-expiry cookie is refreshed
- **WHEN** a request carries a valid session cookie with less than half its TTL remaining
- **THEN** the response sets a refreshed `paas_session` cookie with a new expiry

#### Scenario: fresh cookie untouched
- **WHEN** a request carries a session cookie issued moments ago
- **THEN** no replacement cookie is set


### Requirement: Logout clears the session
The server SHALL expose `POST /api/auth/logout` (and accept `GET` for convenience): it clears the session cookie and redirects to `/`. A local logout does not call Logto's end-session endpoint by default; if `LOGTO_END_SESSION=true`, the logout redirect SHALL chain through Logto's end-session URL.

#### Scenario: user signs out
- **WHEN** the user requests logout
- **THEN** the cookie is cleared and subsequent requests are unauthenticated (redirect to Logto on the next app-shell request)

### Requirement: Session secret lifecycle
The server SHALL resolve the cookie-signing secret from `SESSION_SECRET` when set; otherwise it SHALL generate a random secret on first boot, persist it under `PLATFORM_DATA_DIR` (0600), and reuse it across restarts so existing cookies survive restarts. When `AUTH_MODE=logto`, `GET /api/auth/me` SHALL report `mode: "logto"`, `authenticated` (true only with a valid session), and the session's email/groups (null when unauthenticated) — following the introspection shape of the `forward-auth` capability.

#### Scenario: secret persists across restarts
- **WHEN** the server restarts without `SESSION_SECRET` configured
- **THEN** previously issued session cookies still verify (same persisted secret)

#### Scenario: introspection under logto mode
- **WHEN** `AUTH_MODE=logto` and a client calls `GET /api/auth/me`
- **THEN** the response contains `mode: "logto"`, `authenticated`, and the session email/groups (null, authenticated false when no valid session)

