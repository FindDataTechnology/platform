# Proposal: add-in-app-sso-login

## Why

Forward-auth deployments already authenticate users through the existing Caddy → oauth2-proxy → Logto flow, but Platform exposes no in-application entry point. An anonymous browser reaching the app receives a raw 401 and has no clear way to start SSO. The application should make the existing identity flow discoverable and usable without inventing a second authentication system.

## What Changes

- Make `GET /api/auth/me` and the login/static surfaces public while keeping every other API and WebSocket upgrade protected.
- Expose the existing SSO start and sign-out paths as validated same-origin configuration.
- Add an authentication state hook and `/login` page that starts the existing oauth2-proxy flow.
- Show the authenticated email and a sign-out action in Settings → Account.
- Connect the WebSocket only after authentication state is known and reconnect after SSO returns.
- Keep `AUTH_MODE=none` behavior unchanged and do not add local passwords, sessions, or user data isolation.

## Capabilities

| Capability | Section | Notes |
|---|---|---|
| `forward-auth-login` | ADDED | Public identity introspection, SSO entry, sign-out, auth-aware WebSocket lifecycle |

## Impact

- **Code**: `server/auth.js`, `server/routes/misc.js`, `server.js`, `web/src/App.tsx`, `web/src/hooks/useWebSocket.ts`, a small auth hook, login page, Settings account section, and all locale bundles.
- **Deploy**: existing `AUTH_MODE=forward_auth` deployments can use the same `/oauth2/start` and `/oauth2/sign_out` routes; no new service is required.
- **Docs**: document optional `AUTH_LOGIN_PATH` and `AUTH_LOGOUT_PATH` settings and preserve the forward-auth trust-boundary warning.
- **Out of scope**: local username/password authentication, cookie sessions, per-user authorization, and multi-tenant data isolation.
