# add-deployment-branding — implementation notes

## Task 2.3 live probe (rd round trip + ui_locales) — 2026-09-28

The deployed instance (`https://craw.finddatatech.cloud`, image built before
this change) does not yet carry the new `logto-auth.js`. Baseline probed
against it:

- `GET /auth/login?rd=/chat/abc123&ui_locales=zh-CN` → 302 to the Logto
  authorization endpoint. On the OLD code the redirect drops both params (no
  `ui_locales` in the Location, `rd` absent from the state cookie payload —
  confirmed by decoding `paas_oauth_state`: `{state, nonce, codeVerifier: null,
  exp}` only) and the post-callback redirect always lands on `/`.
- The NEW code (verified hermetically in `scripts/test-logto-auth.mjs`, 15/15)
  carries `rd` inside the signed state cookie and passes `ui_locales` through
  to the authorization redirect; the callback redirects to the carried `rd`
  with invalid/absent/protocol-relative values falling back to `/`.

**Full browser round trip (login → hosted page → callback → land on
`/chat/<id>`) and the `ui_locales` observation on the hosted page remain
unverified against the real Logto tenant** — they need this change deployed
(`platform` Jenkins job → ArgoCD resync) plus a manual sign-in, which is a
release-time step, not part of the change. The follow-up when deployed:

1. Open `https://craw.finddatatech.cloud/login` with locale `zh-CN`, click
   sign-in from a `/chat/<sessionId>` page → expect to land back on that
   session.
2. Note whether `auth.finddatatech.cloud`'s hosted sign-in page renders in
   Chinese when `ui_locales=zh-CN` is on the authorization redirect; if
   ignored, the fallback is the Logto console's default-language setting
   (Admin Console → Settings → Languages), and the param stays harmless.

## Task 4.1 icon source note

The design referenced "the fd COS png" (MinIO `scraw-platform-releases`), but
that endpoint (23.144.68.246:30900) was unreachable during implementation
(both direct and via the connected SSH box), and no fd brand png/svg exists in
the repo or the web app. The vendored `build/icon.png` is therefore a
generated 512×512 placeholder (rounded-square "fd" tile in the app's
primary-deep blue, zero deps). A fork (or the fd deployment, once a canonical
icon URL exists) overrides it with `ICON_URL` — no repo edit needed.
