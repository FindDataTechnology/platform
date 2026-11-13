## Context

The gateway is the only public surface: it resolves identity (Logto cookie via `logtoAuth.userFromCookie`, or mini-program JWT via `mpAuth.verifyToken`), maps it to a per-user cell with `registry.ensure(user)`, and proxies everything else (`gateway/index.js`). Cells each run `server.js` with their own SQLite; the mirrored chat history is readable at `GET /api/chat-history/sessions/:id`. `/healthz` is the only public route today. The web app gates every route behind `loginRequired` (App.tsx:152). The mini-program already talks to the gateway with `authHeaders()` and has no i18n runtime. Reference behavior: DeepSeek's share button -> public read-only URL.

## Goals / Non-Goals

**Goals:**
- Zero cell changes: the gateway alone brokers sharing, using identity it has already verified and the cell-resolution machinery it already owns.
- Works for demo users too: shares survive demo-cell reaping because the gateway re-ensures the owner's cell on read.
- One registry, two receiver surfaces (web public page, mini-program page via forward card).

**Non-Goals:**
- Viewer analytics, whole-account sharing, per-turn selection, share editing after creation (revoke + re-create instead).
- Gateway-level caching of shared content (cells are warm in practice; cold start shows a loading state).

## Decisions

### D1: Gateway-owned registry, opaque random tokens
`gateway/share.js` keeps a SQLite DB at the gateway data root: `shares(token TEXT PRIMARY KEY, email TEXT, session_id TEXT, created_at INT, expires_at INT NULL, revoked INT DEFAULT 0)`. Token = 24-char base64url of 18 random bytes (144 bits; comfortably >128). No email or user id inside the token — the registry row is the only mapping.
*Alternative (rejected)*: stateless HMAC tokens encoding owner + session — no revocation without adding a denylist, and any encoding of the owner leaks structure; revocation is a privacy requirement here.
*Alternative (rejected)*: tokens stored in the owner's cell — the gateway cannot verify or route without probing cells, and revocation UI would need cell round-trips; the gateway is the natural trust boundary since it already verifies the creator.

### D2: Read path reuses the existing cell REST endpoint, owner-impersonated
`GET /api/share/:token` (public): look up the row; skip if revoked/expired; `resolveUser`-style reconstruct `{ email }` from the row; `registry.ensure({ email })`; `proxyHttp` a `GET /api/chat-history/sessions/:sessionId` to the cell with `forwardedHeaders(req, { email }, SECRET)` — the cell serves it exactly as if the owner asked, which it already authorizes by construction (per-user cell). The gateway response is `{ title, messages }` passed through.
*Why not a dedicated cell endpoint*: the data, auth model, and serialization already exist; a new endpoint would duplicate the mirror's read path for no behavioral gain.

### D3: Create validates by fetching through the owner cell
`POST /api/share {sessionId}` (authenticated by the caller's real identity): same ensure + proxied fetch as D2 — if the session 404s in the caller's own cell, no token is minted (spec: cannot share what you don't own). The fetched title is stored denormalized in the row for the revoke-list UI without extra round-trips.

### D4: Public-surface placement and rate limit
Share routes register before the catch-all `app.use(async ...)` cell proxy in `gateway/index.js`. `GET /api/share/*` gets a per-source in-memory token bucket (order 30 req/min; 403-style 429 on breach) — the first content-bearing public endpoint gets explicit throttling from day one. No CORS headers are added: the web page is same-origin, mini-program requests are not browser CORS subjects.
*Alternative (rejected)*: global express-rate-limit dependency — one route family doesn't justify a new middleware dependency.

### D5: Web routing exemption
`loginRequired` redirect in App.tsx gains an exemption: paths starting `/share/` render the lazy `SharePage` without auth (the page calls only `/api/share/*`, which the WS/auth bootstrapping never touches). SharePage renders turns with the existing Markdown pipeline in a read-only shell ("由 <owner> 分享的会话" styling without exposing the email — a generic "shared session" banner), plus a not-available state for revoked/unknown/expired.

### D6: Mini-program surface
- New `pages/share/index` registered in `app.config.ts`; reads `token` from router params; fetches `${baseUrl()}/api/share/${token}` with **no** auth header (public); renders read-only turns with the existing `Markdown` component; loading/not-available states.
- Share action on the sessions page (and chat header): calls `createShare` (authenticated), then `Taro.showShareMenu` + `useShareAppMessage` returns `{ title: session.title, path: "/pages/share/index?token=..." }`.
*Why a page beats a poster for v1*: the read-only page reuses the transcript renderer verbatim; a poster needs canvas layout work and ships less fidelity.

### D7: Owner controls
`GET /api/share` lists the caller's unrevoked, unexpired tokens (session id, title, created_at); `DELETE /api/share/:token` sets `revoked = 1` after checking row ownership (email equality). Web puts list+revoke in the sidebar's session row menu; MP puts it under the sessions page entry.

## Risks / Trade-offs

- [First unauthenticated content endpoint on the gateway] → high-entropy tokens, rate limit (D4), identical not-available responses for unknown/revoked/expired, security review task in the checklist before deploy.
- [Gateway gains a persistence surface (SQLite file)] → single table, WAL mode, lives beside the existing gateway data root; inert on rollback.
- [Cold-start latency when reading a share for a stopped cell] → spawn takes seconds; the receiving page shows a loading state; failure surfaces as not-available only when the read genuinely fails. NOTE (verified live): the spawner itself respawns a cell whose process died; the share read additionally drops a stale registry record and re-ensures once. Demo cells are the exception by design — mp-demo-mode deletes a demo cell's data root on exit, so a demo share becomes not-available once its cell is gone; account cells (persistent data root) revive with their mirror intact.
- [Owner email changes break tokens (row keyed by email)] → acceptable: email change already re-keys the cell mapping; document in the spec's revocation flow (owner re-shares).
- [WeChat forward cards require the mini-program to be published for external recipients] → dev/trial recipients work via the standard devtools flow; production rollout note in tasks.

## Migration Plan

Additive routes + new DB file; deploy gateway, then clients. Rollback: revert gateway commit (registry file left inert), clients' share buttons simply fail closed.

## Open Questions

- Share-card cover image and title truncation on WeChat (aesthetic, decidable at implementation).
- Whether the revoke list also surfaces expiry editing later (v2; schema already has the column).
