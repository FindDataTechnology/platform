# Design: add-session-ownership

## Context

Single-process deployments (fd-prod) authenticate many accounts against one server.js: one SQLite history, one dsh runtime, one `ctx.broadcast`. The WS gate already resolves `ws.user` (Logto cookie or MP token → email) — identity exists at the connection, it is simply never consulted by the session store. See proposal.md for the incident and the tenancy positioning.

## Goals / Non-Goals

Goals: history-level privacy on the shared deployment (list scoping, operation gating, per-viewer delivery, per-connection attribution) with zero behavior change for auth-off deployments (dev/e2e) and no WS protocol break beyond additive fields.

Non-Goals: runtime isolation (the agent still reads the shared workspace while serving any user — closes with per-user cells); concurrent turns; UI redesign of the sidebar; session payload slimming (perf-session-open).

## Decisions

### D1 — Owner column, stamped from the recording connection; auth-off ⇒ NULL owner

`chat_sessions.owner TEXT` (additive ALTER, indexed). `recordMessage` gains the turn-origin user; first mirror stamps, never re-stamped (same pattern as the workspace stamp). When auth is off there is no `ws.user`, so owner stays NULL and **NULL-owner rows are visible to everyone** — the auth-off deployment remains exactly today's single-user system, and all 95 existing e2e specs keep passing untouched. Scoping applies only when `ctx.authEnabled`.

*Alternative rejected*: stamping a machine-owner email in auth-off — buys nothing, breaks e2e fixtures that assert list contents.

### D2 — Turn-origin tracking; a prompt switches the runtime to the viewer's session

The dsh event pump (`dsh-events.js`) completes turns without knowing who started them. `ctx` gains a turn-origin record `{ user, sessionId }` set synchronously at prompt dispatch (prompt, skill invocation, cron runner, bot poller — each names its origin), consumed by the assistant-message mirror. At dispatch, the runtime's session id is set to the originating connection's viewed session before `prompt()` — dsh persists sessions by id, so the turn resumes that session's context. Effect: the deployment-global live session follows whoever prompts next ("prompt implies switch"), which is the only correct attribution on a single runtime and preserves the one-turn-at-a-time invariant.

*Alternative rejected*: recording into the viewer's session while the runtime continues the previous session's context — the transcript would lie about what the agent actually saw.

### D3 — Per-connection viewing state as the routing table

`ctx` keeps `WeakMap<ws, { sessionId, user }>`, updated on connect (initial view: only if the user is entitled to the global current session, else no live-transcript push — the client renders welcome/scoped list), `switch_session`, `new_session`, and turn origin. Delivery helpers: `sendToViewers(sessionId, msg)` for turn events / `session_loaded` / `session_renamed`; `broadcastSessions()` iterates clients and computes each connection's scoped list. `session_changed` becomes targeted (today's broadcast flips every client's `currentSessionId`). Global events (model/profile sync, workspaces) stay on `ctx.broadcast`. Turn events gain a `sessionId` field — additive, old clients ignore it.

*Alternative rejected*: client-side filtering of broadcasts — sends the bytes (and the content) to foreign browsers, which is the leak being fixed.

### D4 — Legacy rows via `SESSION_LEGACY_OWNER`, with a safe unset default

Migration backfills `owner = $SESSION_LEGACY_OWNER` where NULL. If the env is unset, rows stay NULL — NULL rows are **admin-visible only** when auth is enabled (strictly safer than guessing, and the migration is idempotent: setting the env later + restart assigns the remainder). fd-prod sets the env to the account that owns today's sessions.

### D5 — Rejections look like existing errors, not new machinery

WS: the existing `{ type: "error" }` shape with an access message. REST: 403 `{ error: "Session owner required" }`-style body, mirroring `requireAdmin`'s convention. `switch_session` validates ownership before touching the runtime; delete/rename gate on `req.user` the same way. session-share's token route stays public (its own auth) and never consults owner.

## Risks / Trade-offs

- [Cross-user "agent is responding" errors] B's prompt during A's turn is rejected with the existing streaming error → acceptable shared-runtime ceiling, documented; the per-user-cell end state dissolves it.
- [Connect-time payload change] A client whose user doesn't own the global current session no longer receives its transcript on connect → the client already handles the welcome state; e2e covers the entitled path.
- [sessions refresh cost ×N clients] Each refresh computes one scoped metadata query per connection → cheap at this scale; memoize per user per refresh tick if it ever matters.
- [Cron/bot turns] They run under internal identities with a bound session; stamp-once means they never re-stamp a user session; their events route to that session's viewers → verified in tasks, no code fork needed.

## Migration Plan

1. Deploy with `SESSION_LEGACY_OWNER` set (fd-prod: the account owning today's sessions).
2. Additive ALTER + idempotent backfill run at boot; no downtime.
3. Rollback: previous build ignores the column; NULL-owner fallback keeps post-rollback rows visible to admins only — no data loss either way.

## Open Questions

- Ops-console treatment of foreign-session rows (badge vs. identical rows) — pure presentation, deferrable to the ops-console capability's next touch.
