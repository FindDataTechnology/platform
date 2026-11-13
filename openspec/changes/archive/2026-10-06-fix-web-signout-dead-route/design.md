# Design: fix-web-signout-dead-route

## Context

The hosted deployment's auth topology after the 2026-10-01 cells cutover:

```
browser ── gateway (sole Logto client) ── cells (AUTH_MODE=forward_auth)
             ├─ /auth/login      (mounted, live)
             ├─ /auth/callback   (mounted, live)
             ├─ /api/auth/logout (mounted, live — probed 302 → Logto end-session)
             └─ /oauth2/*        (NOT mounted — dead since the oauth2-proxy edge left)
```

Cells report `logoutUrl` from `server/routes/misc.js` via `ctx.AUTH_LOGOUT_PATH`. The spawner (`gateway/spawner.js`) sets `AUTH_MODE=forward_auth` but never overrides `AUTH_LOGOUT_PATH`, so cells report the forward-auth-era default `/oauth2/sign_out`. The SPA's Settings sign-out anchor targets it; the gateway's catch-all proxies the request to the cell, which serves the SPA fallback — no cookie is cleared.

Live facts probed 2026-10-06 (all via anonymous curl, no session touched):

- `GET https://platform.finddatatech.cloud/api/auth/logout` → `302` → `https://auth.finddatatech.cloud/oidc/session/end?client_id=asfg4j882f48axmygilhw&post_logout_redirect_uri=https%3A%2F%2Fplatform.finddatatech.cloud%2F`
- The platform Logto app has the post-sign-out URI registered: submitting the end-session confirm form yields `303 → https://platform.finddatatech.cloud/` (verified with a cookie-jar walk, no browser session involved).
- 谦面/facet (`AUTH_MODE=logto` single process) is unaffected: its SPA already targets `/api/auth/logout` and its end-session chain completes (`303 → https://facet.finddatatech.cloud/`).
- 萬星's Logto app (`b7rsugz1rtma13wcmubuc`) also has `https://wanxing.finddatatech.cloud/` registered — relevant to the sibling fd-wanxing change, not this one.

## Goals / Non-Goals

Goals:
- Make the SPA's sign-out action target a route that exists, restoring: cookie cleared + SSO session ended + return to site root.
- Keep the fix at the topology owner (the gateway spawner), not in shared route code.

Non-Goals:
- Changing the `AUTH_LOGOUT_PATH`/`AUTH_LOGIN_PATH` defaults (self-hosted oauth2-proxy edge deployments keep working as-is).
- Making the logout handler honor `rd` (the site-root landing plus the unauthenticated gate bounce to `/auth/login` is accepted behavior; documented in the proposal).
- 萬星 console sign-out (separate repo/change) or any Logto tenant configuration.

## Decisions

### D1: Fix via spawner env, not shared code or a gateway alias

The cell env block already encodes topology (`AUTH_MODE`, `CLOUD_MODE`, `CELL_GATEWAY_SECRET`). Adding `AUTH_LOGOUT_PATH: "/api/auth/logout"` and `AUTH_LOGIN_PATH: "/auth/login"` there states the invariant where it belongs: cells live behind the gateway, and the gateway owns the auth entry/exit routes.

Rejected alternatives:
- Branch in `server/routes/misc.js` on `CLOUD_MODE`: couples a shared route used by every deployment shape to one topology; env already exists for exactly this.
- Gateway alias `/oauth2/sign_out` → logout handler: adds a permanent compat surface for a URL nothing legitimate references anymore (the repo has an explicit precedent against shallow aliases from the `/api/ready` contract).

`AUTH_LOGIN_PATH` is set alongside for coherence even though anonymous browsers never reach the cell SPA on this topology (the gate redirects HTML to the gateway's `/auth/login`): any in-app logged-out rendering (e.g. an expired session) then gets a working login href instead of a dead one.

### D2: No change to the logout handler or Logto configuration

`LOGTO_END_SESSION=true` and the registered post-sign-out URI are already live and correct — the only broken link was the URL the SPA calls. The `rd=/login` query the UI appends stays ignored (existing handler behavior).

### D3: Verification is a live browser chain, not new route tests

Existing e2e covers the forward_auth defaults and stays valid. The behavior added here is a deployment-env contract; the meaningful check is the end-to-end sign-out on a real session: click 退出登录 → `paas_session` gone → Logto end-session hop → back on the site root logged out, and a second browser check that the SSO session is really dead (re-login requires the password form, not a silent bounce). A unit assertion on the spawner env block is included only if the env construction is importable without spawning a process; otherwise the live chain is the gate.

## Risks / Trade-offs

- Env takes effect per cell spawn: after the gateway pod rolls, existing resident cells keep the old env until they respawn (idle reaping or gateway restart handles this; the rollout restarts the gateway, which stops all cells — "no cell outlives the gateway").
- `AUTH_LOGIN_PATH` changes a value the SPA may render for logged-out states; the only consumers are hrefs, and the new value is strictly more correct on this topology.
- If a future edge proxy reintroduces `/oauth2/*`, the env override must be revisited — the comment on the env lines states this dependency.
