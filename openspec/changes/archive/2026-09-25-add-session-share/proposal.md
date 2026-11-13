## Why

Users cannot show a conversation to anyone else: the web and mini-program clients are both identity-gated, and sessions live inside per-user cells that only their owner can reach. DeepSeek-style session sharing — create a link, recipient opens a read-only view — is table-stakes for a chat product and drives organic distribution via WeChat forward cards.

## What Changes

- Share button on the session view surfaces (web chat header + sidebar session rows; mini-program sessions page and chat header) that creates a share token for one session.
- The gateway gains a share-token registry (small SQLite at the gateway data root): token -> owner email + session id + creation time + revoked flag + optional expiry. Creating a share requires the caller's verified gateway identity (Logto cookie or mini-program JWT); cells stay untouched.
- A public, unauthenticated read path — the gateway's first content-bearing public endpoint:
  - `GET /api/share/:token` returns the session's mirrored turns (title + `{role, content}` list), resolving the owner's cell on demand (re-spawning a stopped account cell; a demo cell's ephemeral data is gone with the process, yielding the standard not-available response) and proxying the existing cell REST endpoint with the owner's identity.
  - Web public route `/share/:token` renders the read-only view, exempted from the global login redirect.
  - Mini-program read-only page `pages/share/index?token=...`, opened via WeChat forward card (`useShareAppMessage`) from the sharer's client.
- Owner controls: list active shares, revoke (soft-delete the registry row); revoked or unknown tokens return a "no longer available" page, never session content.
- Abuse controls: 128-bit random tokens (no enumeration), rate limiting on the public endpoint, no attachment/credential content in the shared payload (mirrored text turns only, which is all the mirror stores).

Non-goals (v1):
- View counting / viewer analytics, expiry-by-default, per-turn selection (share is whole-session), shared-session search.
- Sharing sessions that only exist live (un-mirrored) — the mirror is the source of truth.
- Posters/images (a canvas summary card can layer on later without backend changes).

## Capabilities

### New Capabilities
- `session-share`: gateway share-token registry, authenticated token creation, public read-only session view on web and mini-program, revocation, and abuse controls.

### Modified Capabilities

(none — `cell-gateway`, `chat-history`, and `miniprogram-client` requirements are unchanged; the share read path reuses the existing cell REST endpoint and the gateway's existing cell-resolution machinery additively)

## Impact

- `gateway/index.js` (+ a new `gateway/share.js` module): share routes before the catch-all cell proxy; registry storage at the gateway data root; rate limit on the public GET.
- `web/src/App.tsx`: `/share/:token` public route + `loginRequired` exemption.
- `web/src/pages/SharePage.tsx` (new): read-only transcript view (reuse Markdown rendering), "no longer available" states.
- Web chat header + sidebar session rows: share button, token URL copy, my-shares revoke list.
- `miniapp/src/pages/share/` (new page) + `app.config.ts` registration: read-only view via `GET /api/share/:token`.
- Mini-program sessions page + chat header: share button; `useShareAppMessage` forward card carrying the token path.
- `@platform/core`: REST client additions (`createShare`, `listShares`, `revokeShare`, `getSharedSession`).
- Security review: first unauthenticated content endpoint on the public gateway surface (token entropy, rate limit, no PII in tokens, no CORS widening).
