# Tasks

## 1. Public authentication surface

- [x] `server/auth.js`: allow anonymous `GET`/`HEAD` non-API/non-external SPA shell routes while keeping protected APIs and WebSocket upgrades behind the forward-auth identity requirement
- [x] `server/routes/misc.js`: return mode, email, groups, authenticated state, and validated login/logout paths from `GET /api/auth/me`
- [x] `server.js`: read and validate `AUTH_LOGIN_PATH` and `AUTH_LOGOUT_PATH`
- [x] `.env.example`: document the optional SSO path settings and preserve the trust-boundary warning

## 2. Frontend authentication state

- [x] Add a small auth Zustand hook that fetches `/api/auth/me` and supports explicit refresh
- [x] Add `/login` route and localized login page
- [x] Guard protected routes behind the auth state without changing `AUTH_MODE=none`
- [x] Add account email and sign-out action to the Settings → Account section
- [x] Add login/logout/error strings to en, zh-CN, es, fr, and ja locale bundles

## 3. WebSocket lifecycle

- [x] Update `useWebSocket` to accept an enabled flag
- [x] Close the socket on login/sign-out state transitions
- [x] Prevent anonymous forward-auth loads from opening a WebSocket

## 4. Tests and documentation

- [x] Extend `e2e/auth-catalog.spec.js` for public identity, protected routes, public login/assets, and validated SSO paths
- [x] Add browser coverage for the login page and auth-aware account action
- [x] Run focused auth E2E, complete fast E2E, `npm run web:build`, and OpenSpec validation
- [x] Sync the delta spec into `openspec/specs/forward-auth/spec.md` and archive the completed change
