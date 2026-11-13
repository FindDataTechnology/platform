## Why

The mini program's account-binding journey is the single largest usability
burden in the product today. A new WeChat user who opens the mini program:

1. is dropped on an unbound welcome state with a "先体验 · 免登录直接对话"
   banner — they must tap before they can talk to anything;
2. when they decide to bind, the login page tells them to open
   `/api/mp/bindcode` in a desktop browser — a bare path nobody recognizes,
   which hides the fact that a ready-made binding block already lives in
   web Settings → Account → 微信小程序;
3. must then type a 6-digit code by hand on the phone while reading it off a
   computer screen — no scan, no QR, no in-app guidance.

Each step loses users. Meanwhile the deployment already has every ingredient
for a one-scan journey: an authenticated web session that can mint a bind
code, a demo sandbox that gives anonymous visitors something to do, and a
`wx.scanCode` camera API on the client. This change wires them together and
removes every avoidable decision from the user's path.

Discovered while dogfooding the resource-library release on a real device:
the disconnect line showed neither the server address in use nor any failure
reason, and the only address editors (login page's collapsed 高级 field, the
history drawer's 服务器 row) are invisible exactly when the app cannot
connect. That diagnostics work (already coded, uncommitted) ships with this
change.

## What Changes

1. **Web: a dedicated "微信小程序" Settings section** (`/settings/wechat-app`)
   promoted out of the Account page's embedded block, showing the bind code
   AND a QR rendering of it side by side. The QR encodes
   `<origin>/settings/wechat-app?bindcode=<code>` so the same secret serves
   both scan and manual entry. Purely additive to the settings surface; the
   server-side `/api/mp/bindcode` endpoint is unchanged.
2. **Mini program: scan-to-bind becomes the primary path.** The login page is
   reorganized around a single main button 【扫码绑定】 that opens the camera
   (`wx.scanCode`); the scanned payload is parsed (URL with `bindcode=`,
   bare 6 digits, or scheme form) and redeemed through the EXISTING
   `login-bindcode` exchange — no new server route. Manual 6-digit entry
   stays as the fallback. Bind success auto-navigates back to chat.
3. **Mini program: an illustrated bind-guide page** (`pages/bind-guide`) —
   four CSS-drawn steps (open `https://craw.finddatatech.cloud` on a
   computer → sign in → open ⚙ 设置 → 微信小程序, scan the QR), with a
   copy-to-clipboard URL row. The URL shown derives from the currently
   connected server address, so dev builds point at the dev server.
4. **Mini program: unbound users land in the demo sandbox automatically**
   (currently they park on an unbound banner on the account server and must
   tap 先体验). The banner in demo is upgraded to a bind CTA
   （绑定账号解锁完整功能 ›）which exits demo, returns to the account server,
   and opens the login page — one tap, straight into the scan flow. This
   revises the mp-demo-sandbox rule that the client "enters and leaves the
   sandbox deliberately": entry becomes automatic, exit/upgrade stays
   deliberate.
5. **Mini program: connection diagnostics on the disconnect line** (coded
   during the release, included here): the line shows the server address in
   use with a 修改 affordance (opens the login page with the server field
   expanded), plus the transport's own failure text (`request:fail url not
   in domain list` and friends) — the only surface a real device has for
   either.

Out of scope: server-side QR endpoints or session-scoped QR secrets (the
code remains the single-use, 5-minute secret — QR is just its shape);
WeChat-side changes (domain lists, console flows); the gateway-shaped
`MP_DEMO_MODE` upgrade path (the sandbox stays a separate deployment).

## Capabilities

### New Capabilities
- `mp-bind-guide`: the mini program's illustrated, copy-first binding
  tutorial page — where to go on the web, what to scan, server-address aware.

### Modified Capabilities
- `miniprogram-auth`: scan-to-bind as the primary first sign-in (QR payload
  parsing, manual entry as fallback), login-page copy that names the web
  Settings location instead of a bare API path, and auto-return to chat on
  success.
- `mp-demo-sandbox`: automatic entry for unbound users (replacing the
  deliberate 先体验 tap) and the in-demo bind CTA that exits to the account
  server's login page; the "enters and leaves deliberately" rule is revised
  accordingly.
- `settings-surface`: a dedicated 微信小程序 section in the settings
  navigation, carrying the QR + code binding block out of the Account page.
- `miniprogram-client`: the disconnect line's diagnostics — server address
  with an editable affordance and the transport error text, plus the
  login page's server field auto-expansion.