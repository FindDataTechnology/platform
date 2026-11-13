# Tasks: add-single-process-mp-auth

## 1. Server: MP identity wiring

- [x] 1.1 In `server.js`, build `ctx.mpBindings` + `ctx.mpAuth` from env (`MP_APPID`/`MP_SECRET`/`MP_TOKEN_SECRET`/`MP_TOKEN_TTL_HOURS`, `MP_JS_CODE_URL` override) importing `gateway/mp-auth.js` + `gateway/mp-bindings.js`, bindings file at `storeDir("data")/mp-bindings.json` (design D1/D4); `await mpBindings.load()` at boot. Verify: server boots with the vars unset and set (no behavior change when unset).
- [x] 1.2 Create `server/routes/mp.js` mirroring the gateway's four handlers (`GET /api/mp/bindcode` cookie-or-Bearer + HTML/JSON split, `POST /api/mp/login`, `POST /api/mp/login-bindcode`, `DELETE /api/mp/bind`; same status codes and JSON shapes — design D2), register it in `server.js` with the other route modules. Verify: routes answer 401/not-configured per gateway contract when probed with curl.

## 2. Server: auth gates accept the MP token

- [x] 2.1 In `server/auth.js`, exempt `/api/mp/login` + `/api/mp/login-bindcode` from the logto session requirement (own-auth pattern, like the bot webhook prefixes), and in the logto branch accept `Authorization: Bearer` via `ctx.mpAuth.verifyToken` → `req.user = { email, groups, mp: true }` when the cookie fails (design D3). Verify: curl with a minted token reaches an authed API route; anonymous still 401s; SPA pre-login `/api/config` + `/api/auth/me` still 200.
- [x] 2.2 In `server/ws.js`, extend `authorizeUpgrade` + `userForConnection` logto branches to accept the Bearer token as a fallback identity (design D3). Verify: WS upgrade with token succeeds, without token 401s, cookie path unchanged.

## 3. Mini-program client: boot probe

- [x] 3.1 Change `ensureAuth()` in `miniapp/src/lib/auth.ts` to probe `/api/auth/me`: `200` + `mode === "none"` → `"none"`; otherwise (incl. non-200 like the gateway's 401) → `silentLogin()` (design D5). Verify: `node --test` miniapp auth-related tests if present, plus devtools against a local no-auth server (connects tokenless) and against a logto+MP server (silent login path taken).
- [x] 3.2 Update the stale comments in `miniapp/src/lib/auth.ts` (boot-probe contract) and `gateway/mp-auth.js` / `gateway/mp-bindings.js` headers to state dual use (gateway + single-process). Verify: comment review, no behavior change.

## 4. Integration test

- [x] 4.1 Add `scripts/test-mp-single-auth.mjs` modeled on `scripts/test-mp-auth.mjs`: boot the real single-process server (`AUTH_MODE=logto`, mock code2Session via `MP_JS_CODE_URL`, mock Logto discovery/JWKS upstream, `PLATFORM_DATA_DIR` temp dir) and exercise: bindcode mint (cookie) → login-bindcode → silent re-login → Bearer REST call → Bearer WS upgrade → logout → `binding_required`; wrong/reused bind code 401; forged/expired token 401; MP unset → 503 not-configured + browser public paths unchanged. Register in `package.json` `test:unit` alongside the gateway test. Verify: `node --test scripts/test-mp-single-auth.mjs` passes.

## 5. Docs

- [x] 5.1 DEPLOY.md: move the MP env table note from the gateway-only section to cover single-process logto deployments too (enablement steps + the WeChat legal-domain prerequisite), and note `data/mp-bindings.json` as the single-process bindings location. Verify: docs read-through, paths match implementation.
- [x] 5.2 `.env.example`: add the commented `MP_*` block for single-process use. Verify: file lists all four MP vars with one-line purposes.
