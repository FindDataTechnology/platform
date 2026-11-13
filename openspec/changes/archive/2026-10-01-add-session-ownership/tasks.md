# Tasks: add-session-ownership

## 1. Storage

- [x] 1.1 Add `owner TEXT` to `chat_sessions` (additive ALTER + index) in `db.js`, with the idempotent `SESSION_LEGACY_OWNER` backfill where owner IS NULL; verify with a fresh-home boot (column exists, backfill applies) and a restart (no-op)
- [x] 1.2 Extend `db.js` session queries for scoping: `listChatSessions({ owner, includeAll })`, owner predicate on get/delete/update title paths; verify listChatSessions returns only owned rows for a non-admin owner and all rows with includeAll

## 2. Ownership stamping + attribution

- [x] 2.1 Thread the submitting user through `recordMessage` (turn-origin user on ctx, set at prompt dispatch for WS prompt / skill invocation / cron runner / bot poller) and stamp owner on first mirror, never re-stamp; verify a two-user unit path stamps each first message's user and never overwrites
- [x] 2.2 Auth-off keeps NULL owner and unrestricted visibility (`ctx.authEnabled` gate around scoping only); verify the full existing e2e suite passes unchanged (auth-off mode, no scoping)

## 3. Per-connection viewing state + event routing

- [x] 3.1 Add `ctx` per-connection view map `{ sessionId, user }` (connect / switch_session / new_session updates) + `sendToViewers(sessionId, msg)` helper and `sessionId` field on turn events; verify a unit probe that two mock connections viewing different sessions receive disjoint turn events
- [x] 3.2 Route `session_loaded`, `session_changed`, `session_renamed`, turn events through per-viewer delivery; make `sessions` refreshes per-connection scoped (`broadcastSessions()`); verify the WS-level test: a foreign client receives no `session_loaded`/turn events and its `sessions` payload contains only its own rows
- [x] 3.3 Connect-time push: skip the live-transcript push when the connecting user is not entitled to the current session (scoped sessions list still pushed); verify a connect probe with a non-entitled user gets the scoped list and no foreign transcript

## 4. Operation gating

- [x] 4.1 Gate `switch_session` (WS) and the REST session read/delete/rename on owner-or-admin, WS `error` / REST 403 shapes per design D5; verify probes: foreign switch rejected with runtime unchanged, foreign REST read/delete/rename all 403 with no content leaked
- [x] 4.2 Prompt implies switch: at dispatch, set the runtime session id to the originating connection's viewed session before `prompt()`; verify a two-connection test where B's prompt lands (user message + reply) in B's viewed session and A's transcript is untouched

## 5. End-to-end + docs

- [x] 5.1 E2E (auth-on fixture, two users): disjoint session lists, foreign open-by-id rejected, per-viewer streaming, prompt attribution — one spec file, verify it passes alongside the existing suite
- [x] 5.2 Run `openspec validate --strict` for this change and the full e2e suite; document `SESSION_LEGACY_OWNER` in .env.example and DEPLOY.md (fd-prod value = the account owning today's sessions)
