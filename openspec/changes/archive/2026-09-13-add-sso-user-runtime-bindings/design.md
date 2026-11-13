# Design: add-sso-user-runtime-bindings

## Context

See `proposal.md` for the motivation and capability boundary. Platform currently has one Express process, one dsh child, one shared agent session, global model state, and a global MCP configuration store. The existing forward-auth implementation treats proxy identity as a hard gate. The in-application SSO entry added by the prior change exposes identity only for `AUTH_MODE=forward_auth`; anonymous mode has no identity overlay.

The deployment already uses Caddy `forward_auth`, oauth2-proxy, and Logto. The proxy injects `X-Forwarded-Email` and `X-Forwarded-Groups` into HTTP requests and WebSocket upgrades. For optional SSO, the proxy must allow anonymous requests to reach Platform while injecting those headers when an oauth2-proxy cookie exists.

## Goals / Non-Goals

**Goals:**

- Preserve anonymous use when `AUTH_MODE=none`.
- Add an opt-in SSO identity overlay using the existing proxy/IdP flow, without local passwords or Platform sessions.
- Persist model and MCP availability choices by normalized SSO email.
- Apply a user's effective profile to the shared runtime only when it is idle, with an explicit pending state while busy.
- Keep MCP credentials and complete configurations global and server-side.
- Keep global MCP mutations administrator-only when authentication is enabled.
- Make personal and global state distinguishable in the UI and WebSocket protocol.

**Non-Goals:**

- Local username/password authentication, Platform-owned cookies, or a user account table.
- Per-user chat, document, workspace, session, or credential isolation.
- Per-user MCP URLs, headers, keys, or complete server configurations.
- Multi-process or multi-runtime tenancy.
- Automatically restoring the global profile when a user signs out.

## Decisions

### D1 — Optional SSO identity is an overlay, not a new auth mode

`AUTH_MODE=forward_auth` retains its current hard-gate behavior and `req.user` semantics. A new `SSO_ENABLED=true` setting is interpreted only when `AUTH_MODE` is unset or `none`: the app remains public, but trusted proxy headers create an internal SSO identity for binding endpoints and WebSocket synchronization. The optional identity is not assigned to `req.user`, does not bypass the forward-auth administrator gate, and is not accepted from browser-controlled data.

Alternative considered: make optional SSO a third `AUTH_MODE`. Rejected because it would blur the existing hard-gate contract and require changing every route's auth classification. The overlay keeps the existing mode semantics intact.

### D2 — Email-keyed preferences are separate from global preferences

Migration v12 adds `user_model_bindings(email, provider_id, model_id, updated_at)` and `user_mcp_bindings(email, name, enabled, updated_at)`. Email is trimmed and lowercased at the server boundary. The existing `user_preferences` table remains global and unchanged. No `users` table is introduced; the two tables are preference records keyed by an identity supplied by the trusted proxy.

Alternative considered: store bindings as JSON in `user_preferences`. Rejected because it would obscure identity scope, make MCP rows difficult to query/update atomically, and weaken the separation between global and personal state.

### D3 — Effective profile is composed, not copied

The global model/default MCP configuration remains the source of truth. A personal model binding supplies an optional provider/model override. A personal MCP binding supplies only an enabled/disabled overlay for an existing global server. The runtime coordinator composes these into one effective profile. It never writes personal values into `extension_configs`, `mcp.json`, or provider settings.

Alternative considered: create a complete per-user runtime profile. Rejected because it would imply per-user credentials and configuration isolation that the single runtime cannot provide.

### D4 — Runtime application is idle-only and serialized

The coordinator tracks the active profile, whether the runtime is streaming or changing, and at most one pending requested profile per identity. A model change uses the existing dsh restart path; an MCP-only change uses the existing patch hot-swap path. Global MCP mutations and personal overlay applications share one serialized mutation chain. If the runtime is busy, the database write succeeds and the response reports pending; the coordinator retries after the current operation completes. A failed application leaves the previous runtime active and returns an error to the requesting client.

Alternative considered: immediately restart on every save. Rejected because it would interrupt user turns and race with global MCP management.

### D5 — WebSocket identity is fixed at upgrade

HTTP and WebSocket identity continues to come from proxy headers. The frontend closes and reconnects the socket after optional SSO login or sign-out. The server sends a targeted `user_bindings` snapshot only to the socket with that identity. It broadcasts `runtime_binding` and `runtime_binding_pending` to all clients with effective model/MCP state but no email. This preserves the existing shared broadcast model while preventing personal binding payloads from leaking across users.

Alternative considered: send identity in a client WebSocket message. Rejected because browser-controlled identity would bypass the proxy trust boundary.

### D6 — Explicit model selection remains global

The existing `set_model` message and `/model` command continue to change the shared runtime as explicit global operations. They do not implicitly create or update a personal binding. The personal model save action is a separate authenticated REST operation. This avoids surprising users who are only trying a model for the current shared session.

### D7 — UI exposes ownership and pending state

The account and welcome surfaces show optional SSO login and the current personal profile state. The Models page and model control distinguish the active runtime model from the saved personal model and provide a “save as my model” action. The Installed MCP surface distinguishes the global enabled switch from the personal availability switch. Global add/edit/remove controls remain administrator-facing when auth is enabled. Pending runtime state is visible and never presented as applied before confirmation.

## Risks / Trade-offs

- **Trusted-header forgery:** Optional SSO is safe only when Platform is reachable exclusively through the configured proxy. Mitigation: document localhost/firewall binding and reject browser-supplied identity sources.
- **Shared runtime visibility:** A model or MCP profile change affects the one runtime used by all clients. Mitigation: broadcast effective runtime state and label personal ownership in the UI; do not claim tenant isolation.
- **Restart/hot-swap latency:** Applying a profile can briefly disable model selection or MCP actions. Mitigation: reuse existing pending configuration UI and serialize mutations.
- **Email normalization:** Case or whitespace differences could create duplicate preferences. Mitigation: trim and lowercase at every write boundary and use database primary keys.
- **Database failure:** Binding persistence can fail independently of chat. Mitigation: return `503` for binding APIs, keep anonymous chat available, and show a recoverable UI error.
- **Admin authorization:** Optional SSO groups must not be confused with forward-auth admin authorization. Mitigation: keep `req.user` and optional identity separate and gate global mutations with the existing admin check.

## Migration Plan

1. Add migration v12 and deploy it transactionally before enabling optional SSO binding APIs.
2. Add the optional identity overlay and public `/api/auth/me` fields with `SSO_ENABLED` defaulting to false, preserving current anonymous and forward-auth behavior.
3. Add authenticated binding APIs, the runtime profile coordinator, and serialized MCP overlay application.
4. Add targeted/global WebSocket events and update frontend stores/components to distinguish personal state, global state, and pending application.
5. Enable optional SSO in a deployment only after confirming the proxy allows anonymous requests and injects trusted headers.
6. Roll back by disabling `SSO_ENABLED` and the new UI actions; leave migration rows intact so re-enabling restores user preferences. Do not reset the shared runtime or global MCP configuration during rollback.
