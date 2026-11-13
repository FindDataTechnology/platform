# Proposal: fix-web-signout-dead-route

## Why

Since the 2026-10-01 cells cutover (the gateway became the sole Logto client, replacing the Caddy + oauth2-proxy edge), clicking "Sign out" in the hosted 壹座 web UI is a no-op. Cells run `AUTH_MODE=forward_auth` and report the default `logoutUrl: "/oauth2/sign_out"`, but nothing in the gateway deployment mounts `/oauth2/*` anymore — the request falls through the catch-all into the cell's SPA fallback, the session cookie is never cleared, and the Logto SSO session survives. Live-probed 2026-10-06: the gateway's own `/api/auth/logout` is mounted and correct (302 → Logto end-session with `client_id` + registered `post_logout_redirect_uri`), the SPA just never calls it.

## What Changes

- The gateway's cell spawner adds `AUTH_LOGOUT_PATH=/api/auth/logout` (and `AUTH_LOGIN_PATH=/auth/login` for coherence) to every spawned cell's environment, so the cell's `GET /api/auth/me` reports the gateway's real logout route instead of the dead forward-auth-era default.
- Restored sign-out chain on 壹座: clear `paas_session` → 302 to Logto end-session (`LOGTO_END_SESSION=true` in prod) → shared SSO session terminated → 303 back to the site root → unauthenticated gate bounces to `/auth/login`.
- The `AUTH_LOGOUT_PATH` default stays `/oauth2/sign_out`: self-hosted forward-auth/oauth2-proxy deployments are untouched.
- The `rd=/login` parameter the UI appends remains ignored by the logout handler (post-sign-out landing stays the site root) — documented, not changed.
- Out of scope: 萬星 console sign-out (separate change in the fd-wanxing repo) and 谦面/facet (single-process, live-verified working end-to-end on 2026-10-06).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `cell-gateway`: add a requirement that gateway-spawned cells advertise auth entry/exit paths that exist in the gateway deployment — a cell's reported `logoutUrl`/`loginUrl` MUST name a route the deployment actually serves, so the Settings sign-out action clears the session and ends the Logto SSO session.

## Impact

- `gateway/spawner.js`: two env lines in the cell env block (with a comment stating the invariant).
- No shared route code changes; `normalizeAuthPath` validation applies to the new values as to any override.
- Existing e2e assertions (`e2e/auth-catalog.spec.js`) exercise forward_auth defaults and are unaffected.
- Deployment: takes effect when the platform (gateway) pod rolls; cells inherit the env at next spawn (cell restart happens naturally via idle reaping/rollout).
- Verification: browser sign-out end-to-end on fd-prod — cookie cleared, Logto SSO session ended, land on the site root.
