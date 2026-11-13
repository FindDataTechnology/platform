## 1. Gateway share registry

- [x] 1.1 Create `gateway/share.js`: SQLite registry at the gateway data root (`shares` table per design D1: token/email/session_id/title/created_at/expires_at/revoked, WAL) and verify a scratch script creates, lists, and revokes rows
- [x] 1.2 Implement token minting (24-char base64url of 18 random bytes) and verify uniqueness/entropy expectations across 10k mints
- [x] 1.3 Register routes in `gateway/index.js` before the catch-all cell proxy — `POST /api/share` (identity-required, validates the session via a proxied fetch through the caller's own cell per design D3), `GET /api/share` (list own), `DELETE /api/share/:token` (revoke own) — and verify with the stub-cell seam that foreign session ids and foreign tokens are rejected

## 2. Public read path

- [x] 2.1 Implement public `GET /api/share/:token` (registry lookup -> skip revoked/expired -> `registry.ensure({email})` -> proxy `GET /api/chat-history/sessions/:id` with forwarded owner identity) and verify: anonymous curl returns the session; revoked/unknown/expired tokens return the indistinguishable not-available response
- [x] 2.2 Add the per-source in-memory rate limit (~30 req/min) on `GET /api/share/*` and verify a probe loop gets throttled while normal opens pass
- [x] 2.3 Verify demo-cell revival: reap the owner's demo cell, request the token, confirm the gateway re-spawns the cell and serves the share (stub-cell or dev cell)

## 3. Web client

- [x] 3.1 Add core REST clients (`createShare`/`listShares`/`revokeShare`/`getSharedSession` in @platform/core) and verify unit/build pass
- [x] 3.2 Add the `/share/:token` public route with the `loginRequired` exemption and lazy `SharePage` (read-only Markdown transcript, shared-session banner, loading + not-available states) and verify a logged-out browser renders a valid token and a revoked one shows not-available
- [x] 3.3 Add share actions to the web (chat header share button + sidebar session row menu: create, copy URL, my-shares list with revoke) and verify the end-to-end loop in a browser: create -> open in a private window (logged out) -> revoke -> refresh shows not-available
- [x] 3.4 Add locale strings for all share UI text to the five `web/src/locales/*/common.json` and verify the web build + i18n lint pass
- [x] 3.5 Add a web e2e spec (share creation, public open while logged out, revoke cuts access) and verify it passes in the Playwright harness

## 4. Mini-program client

- [x] 4.1 Create `pages/share/index` (registered in `app.config.ts`): token from router params, unauthenticated fetch of `GET /api/share/:token`, read-only Markdown rendering, loading/not-available states; verify in WeChat devtools with a real token
- [x] 4.2 Add share actions on the MP side (sessions page entry + chat header): `createShare` then forward via `useShareAppMessage` with `path=/pages/share/index?token=...`; verify the forward card opens the shared page in a second devtools session as a different (unbound) user
- [x] 4.3 Add revoke entry to the MP sessions page (list own shares, revoke) and verify revocation reflects on a previously opened share page on reload
- [x] 4.4 Verify via wechatide automation per the existing MP test recipe (WXML assertions for share page states) and record the walkthrough result

## 5. Security and wrap-up

- [x] 5.1 Security pass on the new public endpoint (token entropy source, rate-limit behavior, no PII in responses/tokens, no CORS widening, identical error bodies) — record findings in the change notes
- [x] 5.2 Run `openspec validate add-session-share` and the full affected e2e suites; record results
