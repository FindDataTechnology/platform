# Proposal: add-single-process-mp-auth

## Why

The WeChat mini-program client's login path (`/api/mp/*`, account binding with
bind codes) exists only in the multi-tenant gateway (`gateway/index.js`). The
deployments that actually run today — `npm start`, the Electron app, and the
single-process k8s pod behind `https://craw.finddatatech.cloud` — run
`server.js`, where a mini-program client cannot log in at all: its boot probe
(`GET /api/config`) is public-200 in `AUTH_MODE=logto`, so the client assumes
"no auth", the WebSocket upgrade then arrives without a token and is rejected,
and the app sits on 「已断开」 forever. Adopting the gateway shape just to
serve the mini program is a deployment-model change (per-user cells) that a
single shared runtime should not be forced into.

## What Changes

- Mount the mini-program identity path in the single-process server
  (`server.js`, `AUTH_MODE=logto`): the same four endpoints the gateway
  exposes — `GET /api/mp/bindcode`, `POST /api/mp/login`,
  `POST /api/mp/login-bindcode`, `DELETE /api/mp/bind` — reusing the existing
  framework-independent `gateway/mp-auth.js` and `gateway/mp-bindings.js`
  modules (one implementation, two entrypoints).
- Accept the mini-program platform token (`Authorization: Bearer`) as a
  verified identity in the single-process HTTP auth gate and the WebSocket
  upgrade gate — the same second-door standing it has at the gateway. Token
  identity feeds the existing `req.user` / `ws.user` semantics (admin gating,
  role-filtered agent rosters), so a bound mini-program user is treated
  exactly like the same account signed into a browser.
- Persist openid⇄account bindings at `mp-bindings.json` under the platform
  data dir (`PLATFORM_DATA_DIR`, falling back to CWD) — the same file format
  and atomic-write convention as the gateway's copy.
- Keep the browser Logto flow byte-for-byte unchanged: `/api/config` stays
  public (the SPA needs it pre-login), and when `MP_APPID`/`MP_SECRET`/
  `MP_TOKEN_SECRET` are unset the MP endpoints report not-configured and all
  browser traffic is unaffected.
- Change the mini-program client's boot probe from `/api/config` to
  `/api/auth/me`: `/api/config` cannot distinguish "no auth" from "auth
  behind a public config route", while `/api/auth/me` reports the auth mode
  explicitly (`mode: "logto"`) and returns 401 behind the gateway — one probe
  that works against both deployment shapes.
- No changes to the gateway's own MP path, the WS/REST protocol, or the
  browser client.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `miniprogram-auth`: the spec currently states the requirements in terms of
  "the gateway" only. The delta generalizes the identity path to "the
  server" (gateway OR single-process `server.js` in `AUTH_MODE=logto`),
  adds the requirement that the single-process server expose the same
  endpoints/token semantics with bindings persisted in its own data dir,
  and changes the client's boot probe from `/api/config` to `/api/auth/me`
  (both shapes must remain distinguishable: silent-login vs no-auth).

## Impact

- **Server**: `server/auth.js` (Bearer acceptance in logto mode + MP route
  exemptions), new `server/routes/mp.js` (endpoint registration, mirrors
  gateway handlers), `server.js` (wire mpAuth/mpBindings into ctx), `server/ws.js`
  (Bearer acceptance on the upgrade gate).
- **Mini-program client**: `miniapp/src/lib/auth.ts` (`ensureAuth` probes
  `/api/auth/me`; `mode: "none"` → connect tokenless, anything else → silent
  login), rebuilt `miniapp/dist` not required by this change (devtools build).
- **Ops/deployment**: `MP_APPID`, `MP_SECRET`, `MP_TOKEN_SECRET` (already
  documented in DEPLOY.md's gateway table) become meaningful for single-process
  deployments too; `.env.example` + DEPLOY.md updated. WeChat 合法域名 config
  (request + socket lists) is a deployment prerequisite, unchanged by code.
- **Tests**: new integration test mirroring `scripts/test-mp-auth.mjs` for the
  single-process shape (mock code2Session, boot real `server.js` without dsh or
  with a stub, exercise bind → silent login → Bearer REST → Bearer WS upgrade →
  logout, plus the not-configured inertness and browser-flow-unchanged checks).
- **Explicit non-goals**: no gateway→single-process migration tooling (binding
  files are copy-compatible JSON, but no auto-migration is built); no
  `forward_auth` support (a proxy-fronted deployment's identity comes from
  headers the mini program cannot supply); no client protocol changes beyond
  the boot probe.
