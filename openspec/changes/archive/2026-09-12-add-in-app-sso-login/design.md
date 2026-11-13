# Design: add-in-app-sso-login

## Context

The deployment already uses Caddy `forward_auth` with oauth2-proxy and Logto. oauth2-proxy exposes `/oauth2/start` to begin authentication and `/oauth2/sign_out` to remove its own cookie. Platform's current `AUTH_MODE=forward_auth` middleware trusts only proxy-injected `X-Forwarded-Email` and `X-Forwarded-Groups` headers, and the WebSocket upgrade applies the same gate.

The browser must not supply or store proxy identity headers. The proxy injects them for both HTTP requests and the WebSocket upgrade.

## Decisions

### D1 — Public identity introspection

`GET /api/auth/me` is public by method and path. It returns the current mode, email, groups, authentication state, and SSO paths. Other methods remain protected by the global gate. This lets the frontend distinguish anonymous, authenticated, and auth-disabled states without weakening protected APIs.

### D2 — Same-origin SSO configuration

The server defaults to `AUTH_LOGIN_PATH=/oauth2/start` and `AUTH_LOGOUT_PATH=/oauth2/sign_out`. Environment values must be same-origin paths beginning with one `/` and not `//`; invalid values fall back to the defaults. The frontend receives paths, not secrets or external redirect targets, preventing an operator typo from becoming an open redirect.

### D3 — Minimal frontend auth state

A small Zustand hook fetches `/api/auth/me` once and on explicit refresh. `AUTH_MODE=none` immediately enables the normal shell. `forward_auth` with no email renders `/login`; after the proxy redirects back, the hook refreshes and the shell enables. The login page has a single SSO button and an error state.

### D4 — Authentication-aware WebSocket lifecycle

`useWebSocket(enabled)` does not open a socket while authentication is loading or while forward-auth is anonymous. A successful login or sign-out closes the old socket and changes `enabled`, so the next connection uses the identity supplied by the proxy at upgrade time. The server-side fixed-at-upgrade identity behavior remains unchanged.

### D5 — Account action in Settings

The sidebar footer keeps its existing status-and-settings row unchanged. A new Settings → Account section displays the authenticated email and sign-out action; anonymous forward-auth users can open the login page from the same section. `AUTH_MODE=none` shows the open-access state and no SSO action.

### D6 — Deliberate v1 boundary

This change does not create local users, password hashes, application sessions, CSRF defenses, or tenant-scoped storage. The existing deployment remains a single shared application state. Those capabilities require a separate authentication and multi-tenancy design.

## Deployment sketch

```text
browser
  GET /api/auth/me (public, returns mode + SSO paths)
  GET /login (public SPA route)
  GET /oauth2/start?rd=... (Caddy → oauth2-proxy → Logto)
  GET /oauth2/sign_out?rd=/login (Caddy → oauth2-proxy)
  all other HTTP/WS requests (forward_auth → PAAS)
```

## Risks

- A direct, unauthenticated path to `server.js` can forge identity headers. `AUTH_MODE=forward_auth` remains an operator assertion that the server is reachable only through the trusted proxy; localhost binding/firewalling is still required.
- oauth2-proxy's `/oauth2/sign_out` removes the proxy cookie but may leave the upstream IdP session intact; a new `/oauth2/start` can therefore re-authenticate without prompting. This matches the existing deployment's cookie ownership boundary.
