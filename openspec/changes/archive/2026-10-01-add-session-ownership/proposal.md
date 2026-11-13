# Proposal: add-session-ownership

## Why

fd-prod is positioned as multi-tenant, but the chat history has no notion of ownership: `chat_sessions` has no owner column, `listSessions()` returns every row to every requester, and `switch_session`/`getSession` accept any id. Today one authenticated account (e.g. `aloadtree@gmail`) sees — and can open — another account's conversations (e.g. `3106241601@qq.com`). This is a live privacy breach, and the full fix (per-user cells via the gateway/spawner topology) is gated on node capacity. This change is the stopgap that restores history-level privacy on the single-process deployment now.

## What Changes

- `chat_sessions` gains an **`owner` column** (email). A session's owner is stamped from the recording connection's authenticated user (`req.user` / WS gate identity, MP tokens included — they resolve to an email too) at first mirrored message; existing rows are assigned to the deployment administrator so nothing is orphaned.
- **Listing is scoped by requester**: `listSessions()` (and the `sessions` WS push / REST list) returns only sessions the requester owns; the admin group sees all (ops console parity).
- **Access is gated by ownership**: `switch_session`, `getSession`, rename and delete reject a session the requester does not own (403-equivalent error, same shape as the existing not-found errors), so cross-account open-by-id is closed, not just hidden from the list.
- **Prompts attribute to the viewer's session**: a connection's prompt records into the session that connection is viewing, instead of the deployment-global "last switched" session (`ctx.dshSessionId` stays the runtime's single live session — the runtime remains shared and serializes turns; this fixes attribution, not concurrency).
- **Events are delivered per-viewer**: `session_loaded`, turn events, and session-list refreshes go to the connections viewing that session (or the requesting connection) instead of `ctx.broadcast` to every connected browser — another user's transcript never reaches a foreign client.

Non-goals: per-user runtime isolation (a shared agent can still read the shared workspace while serving another user's turn — that leak closes only with the tenant-cell end-state, tracked separately); concurrent turns (one dsh child still streams one turn at a time); session-open performance (perf-session-open); share-link access (session-share's public read-only tokens keep working — they are a deliberate cross-owner door).

## Capabilities

### New Capabilities

- `session-ownership`: the ownership model itself — owner stamping on first message, admin-group visibility, ownership gating of read/switch/rename/delete, per-viewer event delivery, and legacy-row assignment.

### Modified Capabilities

- `chat-history`: the list/read requirements gain requester-scoped semantics (list returns owned sessions; getSession is owner-checked).
- `web-chat-server`: WS message handling gains per-connection viewing-session state and ownership access control; broadcast fan-out narrows to per-viewer delivery.

## Impact

- **Code**: `db.js` (owner column + migration, scoped queries), `chat-history.js` (owner-aware list/get/record), `server/ws.js` (per-connection view state, gating, targeted sends), `server/agent-session.js` (switchToSession ownership check), `server/routes/chat-history.js` (REST parity), mp identity path (WS gate already resolves email — no new plumbing).
- **Deploy order**: none required; standalone. The per-viewer delivery in perf-session-open builds on the same connection state introduced here.
- **No changes**: dsh packages, session-share public tokens, ops console (admin visibility falls out of the group check).
- **Ops**: one-time migration stamps existing rows with the administrator's email — pick that account before deploying (fd-prod: the account that owns today's sessions).
