## Context

The binding chain already exists end to end and is proven on production:
`GET /api/mp/bindcode` (single-use 6-digit code, 5-minute TTL, minted from
the authenticated web session — `server/routes/mp.js` +
`gateway/mp-bindings.js`), redeemed by `POST /api/mp/login-bindcode`
(`gateway/mp-auth.js`). A web block (`MiniProgramBinding.tsx`) already mints
the code but is buried in Settings → Account, and its hint copy says
"当前部署未启用多租户网关" on single-process deployments — wrong today, since
`sha-ea802e5` serves the endpoints there too (the block's 401/404 fallback
misjudged which shapes have the route; the fallback text needs correcting
while it moves). The MP login page (`miniapp/src/pages/login/index.tsx`)
redeems codes but points users at the bare path `/api/mp/bindcode`.

Client mechanics that exist and are reused: `wx.scanCode` (unused so far),
`setClipboardData` (the link-copy path), `Taro.showModal` editable-modals
(broken on some base libraries — do NOT use for the server editor; the login
page's real input is the pattern), `runtime.switchBase()` (full re-boot on
origin change, used by enter/exitDemo), and `ensureAuth`'s `binding_required`
outcome (the auto-demo trigger). The uncommitted diagnostics work
(conn-block, server editor routing, `noteConnError` in `auth.ts` /
`taro-socket.ts`) is included and already verified in the devtools
simulator; it becomes tasks that say "already coded — wire tests", not
rework.

The `qrcode` npm package is the QR renderer for the web (SVG output, no
canvas, works in the existing React tree). The web bundle gains ~10 KB gz.

## Goals / Non-Goals

**Goals:**
- A first-time WeChat user reaches a bound account with one camera scan and
  zero typed digits, and knows where to find the QR without outside help.
- Unbound users get an immediately usable product (auto demo) instead of a
  parked banner.
- A disconnected real device can explain itself (address + transport error)
  and recover without reinstalling or guessing.
- Old servers keep working with the new client (no new server routes), and
  the old client keeps working with the new server (settings section is
  additive).

**Non-Goals:**
- Server-side QR sessions or per-session QR secrets (the code stays THE
  secret; the QR is its shape).
- The gateway-shaped `MP_DEMO_MODE` same-origin upgrade (demo stays a
  separate deployment; the auto-entry is client-side origin switching).
- WeChat console work (domain lists, 体验版/提审 mechanics) — user-side steps.
- Renaming/reworking the Account section beyond removing the embedded MP
  block from it.

## Decisions

1. **The QR encodes the bind code, not a session.** Content is
   `<origin>/settings/wechat-app?bindcode=<code>` — same single-use,
   5-minute secret as the digits, minted by the unchanged endpoint. Rationale:
   zero server changes (deploy-and-compat story above), and no new attack
   surface: the QR and the digits are displayed side by side to the same
   authenticated user; if the QR leaks, the digits leaked. Rejected
   alternative: a server-issued one-time token bound to a session — strictly
   more machinery for the same property.
2. **Parsing lives in a shared, unit-tested helper** (`bindQr.ts` in
   `miniapp/src/lib`): URL-with-`bindcode=` → bare 6 digits →
   last-path-segment/fragment. One order, one place; the login page and the
   guide page both call it. A no-code payload is an explicit error string,
   never a silent no-op.
3. **Scan redemption reuses `loginWithBindCode(code)`** — the same exchange,
   the same error surfaces, the same token persistence. Bind success
   auto-navigates back (existing `navigateBack`/`reLaunch` fallback in the
   login page's submit path).
4. **Auto-demo is a client-side origin switch** on `binding_required`, gated
   to production-shaped builds: only when the paired sandbox origin is known
   (the `DEMO_BASE` pairing already in `config.ts`). Dev builds have no
   paired origin, so nothing changes there. One-shot: a user who exits demo
   is not pushed back in (the remembered origin is the account origin).
5. **The settings section is additive** (`wechat-app` slug, six sections
   total). The block moves out of Account into it; the QR renders
   client-side; the unavailable-fallback text is corrected (single-process
   deployments DO have the route — the degraded states are only 401-not-
   signed-in and route-absent on genuinely older servers).
6. **The server editor is the login page's real input, auto-expanded** via
   `?server=1` — not an editable showModal (broken on some base libraries;
   that is the bug the user hit). The disconnect line routes there.
7. **The guide's URL row derives from the connected account origin**, never
   `DEMO_BASE`, and carries `setClipboardData` + toast (the existing
   link-copy pattern). Schematics are pure CSS/View boxes — no image assets,
   no network, dark-mode free via existing classes.

## Risks / Trade-offs

- **Auto-entry into a shared sandbox surprises users** (their demo session
  is wiped every 2h and 20 prompts per connection). Mitigation: the
  persistent notice names the environment; the spec revision records the
  product decision. If it proves too aggressive, a one-line gate can restore
  the tap-to-enter behavior.
- **The `?bindcode=` URL leaks through the camera roll/browser history if a
  user screenshots the settings page.** The code is single-use and expires in
  5 minutes — the same exposure the digits already have on screen.
- **`wx.scanCode` needs no special scope** but the camera permission dialog
  is WeChat's own; first-scan users see one system prompt. Unavoidable, and
  scoped to the scan moment only.
- **MP bundle grows** (scan + guide page): a few KB; the guide page is lazy
  per Taro page-splitting, loaded only on navigation.
- **QR render correctness is the one real failure mode** (a wrong module
  sequence = unscannable code). Mitigation: an e2e/web test decodes the
  rendered QR's payload and asserts it equals `<origin>/settings/wechat-app
  ?bindcode=<minted>`; the devtools walkthrough scans a REAL rendered QR
  where the simulator supports it, else a mocked `wx.scanCode` payload
  against the real parser and exchange.
