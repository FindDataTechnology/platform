# Design: add-single-process-mp-auth

## Context

The MP identity path today lives in `gateway/index.js` as four express routes
plus a `resolveUser` that accepts either a Logto cookie or a Bearer MP token.
Two of its three building blocks are already framework-independent modules in
`gateway/`: `mp-auth.js` (code2Session + HS256 JWT mint/verify, pure node:crypto)
and `mp-bindings.js` (openid⇄account map + in-memory bind codes, JSON file with
atomic temp+rename writes). The single-process server's auth surface is
`server/auth.js` (`registerAuth`: logto mode authenticates via
`ctx.logtoAuth.authenticate` cookie check, public-path list, exempt prefixes)
and `server/ws.js` (`authorizeUpgrade`/`userForConnection`: logto branch reads
the cookie only). `req.user`/`ws.user` feed admin gating (`requireAdmin`) and
role-filtered rosters (`switchableAgents(ws.user)`).

Constraint that shaped two decisions below: `/api/config` is public in logto
mode because the SPA's `useAppConfig` fetches it pre-login to render branding
(`web/src/hooks/useAppConfig.ts`), and `/api/auth/me` is also public-GET but
reports `mode` explicitly (`server/routes/misc.js:15`). The mini-program boot
probe (`ensureAuth`) infers the world from one anonymous request.

## Goals / Non-Goals

**Goals:**

- One MP identity implementation shared by both entrypoints (no forked copy of
  login/bind semantics).
- Mini-program token = same standing as a browser session in the
  single-process HTTP gate AND the WS upgrade gate, so downstream identity
  consumers (`requireAdmin`, agent rosters, user bindings) work unmodified.
- Browser flows byte-for-byte unchanged (public paths, redirects, cookie
  semantics untouched).
- The mini-program client works against BOTH shapes with one probe logic.

**Non-Goals:**

- `forward_auth` support (proxy headers are unforgeable only behind the proxy;
  a mini program can't be a proxy caller).
- Any gateway behavior change (its routes/`resolveUser` are the reference, not
  an edit target — only shared-module import paths stay stable).
- Binding migration tooling between shapes (same JSON format; copying the file
  is an operator action, documented not automated).
- AUTH_MODE=none deployments: they need no login and already work; MP routes
  stay mounted but report not-configured (mpAuth with empty creds).

## Decisions

**D1 — Reuse `gateway/mp-auth.js` + `gateway/mp-bindings.js` by import, don't move them.**
`server/routes/mp.js` (new) imports both from `../gateway/…`. The modules have
no express/gateway coupling (verified: node:crypto/fs only). Moving them to a
`shared/` location would touch gateway imports for zero behavioral gain.
Alternative rejected: duplicating the JWT/bind logic into `server/` — two
implementations of a security-sensitive path drift.

**D2 — New route module `server/routes/mp.js`, registered before `registerAuth`'s gate semantics matter.**
The four endpoints mount like every other `register*(ctx)` module, but the
login endpoints must be reachable without a session. Mechanism: extend
`server/auth.js`'s exempt machinery with an MP prefix list
(`/api/mp/login`, `/api/mp/login-bindcode`) — same pattern as
`AUTH_EXEMPT_PREFIXES` for bot webhooks ("exempt paths MUST carry their own
authentication"; these do — wx.login exchange + bind code). `/api/mp/bindcode`
and `DELETE /api/mp/bind` are NOT exempt: they authenticate via cookie or
Bearer (see D3), which the logto branch already admits once D3 lands.
Handlers mirror gateway/index.js's route bodies (same status codes, same JSON
shapes, same bindcode HTML page) so `scripts/test-mp-auth.mjs`'s contract
transfers verbatim.

**D3 — Bearer acceptance lives in the auth middleware and the WS gate, not in routes.**
In `registerAuth`'s logto branch, before the cookie check fails the request,
try `ctx.mpAuth.verifyToken(Bearer)` → `req.user = { email, groups, mp: true }`
(same shape the gateway's `resolveUser` produces). Same one-liner shape in
`authorizeUpgrade`/`userForConnection`: cookie first, then Bearer. This puts
the token at exactly the same place a browser identity enters, so nothing
downstream changes. Alternative rejected: per-route auth — would leave WS
unhandled and duplicate identity plumbing.

**D4 — Bindings file: `storeDir()` convention, filename `mp-bindings.json`.**
`createMpBindings({ file: path.join(storeDir("data"), "mp-bindings.json") })`
— under `PLATFORM_DATA_DIR/data/` when packaged, `data/` in dev (matching the
other stores' `storeDir` usage; same filename and JSON shape as the gateway's
`<CELL_DATA_ROOT>/mp-bindings.json`, so a file copied between shapes works).

**D5 — Client probe switches to `/api/auth/me`; the mode field drives the branch.**
`ensureAuth()`: fetch `/api/auth/me`; `200` with `mode === "none"` → `"none"`
(connect tokenless); anything else (`mode: "logto"` with `authenticated:false`,
or a non-200 such as the gateway's 401) → `silentLogin()`. This is the only
client change. Alternative rejected: making `/api/config` return 401
anonymously on single-process — breaks the SPA's pre-login branding fetch
(`useAppConfig`), violating "browser flows unchanged". Alternative rejected:
keying off `authenticated` instead of `mode` — the mini program never has a
cookie, so `authenticated` is always false there; `mode` is the deployment
fact we need.

**D6 — Inertness is inherited, not re-implemented.**
With MP env unset, `createMpAuth` reports `configured: false`, login endpoints
answer 503 "not configured", `verifyToken` returns null (Bearer never
verifies), and no other route or the browser flow knows MP exists. Same
inertness contract the gateway has; no server-side feature flag.

## Risks / Trade-offs

- [Shared modules drift toward gateway-only assumptions later] → The modules
  are explicitly dual-use now (comment headers updated); `test-mp-auth.mjs`
  (gateway) and the new single-process test both exercise them, so a
  gateway-only regression fails at least one suite.
- [Bearer acceptance widens the logto gate's input surface] → Tokens are
  HS256-verified against `MP_TOKEN_SECRET` (constant-time compare, expiry
  checked — `mp-auth.js`), a secret deliberately separate from
  `SESSION_SECRET`/`CELL_GATEWAY_SECRET`. Inert when the secret is unset.
- [WS upgrade timing: token expiry mid-connection] → Same ceiling as the
  gateway and the existing cookie path: identity is fixed at upgrade time; a
  client reconnect re-runs silent login (client contract already handles
  this).
- [`/api/auth/me` gains a second consumer] → Its response shape is now a
  two-client contract; the delta spec pins the `mode` semantics, and the
  existing SPA consumer reads fields the change doesn't alter.

## Migration Plan

1. Deploy is additive: no env changes → behavior identical to today (MP
   inert). Rollback = redeploy previous image.
2. To enable on a single-process logto deployment: set `MP_APPID`,
   `MP_SECRET`, `MP_TOKEN_SECRET`, restart; then configure the WeChat console
   legal domains (`request` `https://<domain>` + `socket` `wss://<domain>`) —
   ops prerequisite, not code.
3. Bindings accumulate at `data/mp-bindings.json`; deleting the file is the
   unbind-all escape hatch.

## Open Questions

- Whether the WeChat console legal-domain lists can register the deployment's
  exact domain is an ops fact discovered at configuration time; if the
  canonical domain can't be registered, serving the MP path on an alternate
  registered subdomain of the same deployment is the fallback (no code
  impact).
