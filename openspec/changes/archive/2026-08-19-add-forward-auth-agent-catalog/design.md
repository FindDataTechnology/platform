# Design: add-forward-auth-agent-catalog

## Context

Target deployment (live on 23.144.68.246, verified 2026-08-18):

```
browser ── Caddy (TLS) ── forward_auth ── oauth2-proxy ── Logto OIDC
                          │ 401 → /oauth2/start?rd=…
                          ▼
                     PAAS server.js (bind 127.0.0.1)
```

The same gate already protects nango.tokenvault.vip (admin variant, 4181) and apps.tokenvault.vip (all-user variant, 4180 — feeds connect-app). oauth2-proxy exposes identity on the `/oauth2/auth` response (`X-Auth-Request-Groups: admin` observed; connect-app consumes `X-Forwarded-Email` end-to-end). PAAS reuses that mechanism verbatim.

## Decisions

### D1 — Auth approach A: header trust, no in-app OIDC

`AUTH_MODE=forward_auth` middleware (~10 lines) reads `X-Forwarded-Email` / `X-Forwarded-Groups`; missing email ⇒ 401.

Rejected: openid-client in PAAS — an extra dependency, callback/redirect plumbing, a second login UX, and it still wouldn't share the `.tokenvault.vip` SSO cookie that the proxy gate already provides across nango/newapi/connect. Desktop/Electron builds stay auth-free (AUTH_MODE unset there).

Trust boundary: the flag is an operator assertion "only the forward-auth proxy can reach me". Enforced by binding to 127.0.0.1 / firewalling, documented with a loud warning in `.env.example` + README. This is exactly how connect-app already trusts `X-Forwarded-Email`.

### D2 — Roles via groups header (P2-A)

Logto `roles` claim → oauth2-proxy groups → `X-Forwarded-Groups`. Catalog entries filter on group intersection. Rejected P1 (email allowlists in config): stale lists and one stale entry = a hole (user's call: "p1有很大的安全风险"). The 4181 admin gate verified the exact header mechanics in production.

### D3 — Remote agent protocol: OpenAI-compat, `mode: chat | link`

`mode: "chat"` → PAAS forks the WS `prompt` to `<baseUrl>/chat/completions` with `stream: true`, translating SSE deltas into the existing `text` events, `done`, `error`. Frontend rendering unchanged. Gives R1 (chat inside PAAS) with R2 compatibility — any OpenAI-compat backend qualifies (new-api, LiteLLM, vLLM…). `mode: "link"` covers agents we cannot speak to: a plain external link. No MCP/agent-protocol fanciness in v1.

### D4 — Config sources: `agents.json` + `AGENTS_CONFIG_URL`

Local = `agents.json` (sibling of `mcp.json`, gitignored; JSON arrays don't belong behind `.env` escaping — `mcp.json` is the established precedent). Cloud = `AGENTS_CONFIG_URL` JSON, same schema. Merge by id, **cloud wins** — the cloud is the live control plane ("云端增减后客户端看到变化" must hold even for ids first defined locally). Fetch failure ⇒ keep last-good + warn (graceful-degradation convention; a cloud outage never empties the catalog). Refresh: interval `CATALOG_REFRESH_SECS` (default 60) + `POST /api/catalog/refresh`; content diff ⇒ `catalog_changed` WS broadcast, clients refetch `GET /api/catalog`.

### D5 — Secrets never reach the browser

`apiKeyEnv` (name of a server env var) is the blessed way to carry a remote-agent key; a literal `apiKey` in a source document works but is discouraged. Every client-facing catalog payload comes from a serializer that whitelists display fields only. The Nango secret lives only in server env (`NANGO_SECRET_KEY`). Extends the existing "tokens stay server-side" convention.

### D6 — Nango connect broker mirrors connect-app

`POST /api/apps/:id/connect` does exactly what connect-app/server.mjs does (proven 2026-08-17): POST `<nangoUrl>/connect/sessions` with secret-key bearer, `tags = {end_user_id, end_user_email, organization_id}` derived from the requesting user's email, respond with the Connect UI URL + `session_token` + `apiURL` query params. Per-user connection isolation via tags was verified at the data layer. Requires `AUTH_MODE=forward_auth` (no identity to tag otherwise).

### D7 — Catalog module shape

`catalog.js` mirrors `extension-store.js` patterns: load → validate (drop bad entries with a warning) → merge → serve redacted; module state + accessors, no DB. Chat-history integration for remote agents is deferred (see ceilings).

## v1 ceilings (deliberate, documented)

- One shared local session (unchanged); remote-agent chats broadcast to all connected clients and are **not** persisted into chat-history.
- WS identity is fixed at upgrade time; no re-auth mid-connection.
- One `NANGO_SECRET_KEY` env var shared by all `nango-connect` entries.
- No catalog editing UI — config is files/URL only.

## Deployment sketch (PAAS behind the general 4180 gate)

```
paas.tokenvault.vip {
	handle /oauth2/* { reverse_proxy 127.0.0.1:4180 { header_up X-Real-IP {remote_host} } }
	handle {
		forward_auth 127.0.0.1:4180 {
			uri /oauth2/auth
			header_up X-Real-IP {remote_host}
			copy_headers X-Forwarded-Email X-Forwarded-Groups
			@error status 401
			handle_response @error { redir * /oauth2/start?rd={scheme}://{host}{uri} }
		}
		reverse_proxy 127.0.0.1:3000
	}
}
```

For an admin-only PAAS instance, swap 4180 → the 4181 admin-gate pattern (`/oauth2-admin/*`, role `admin`).

## Catalog schema

```json
{
  "agents": [
    { "id": "local", "type": "agent-local", "name": "Platform" },
    { "id": "junior", "type": "agent-remote", "mode": "chat", "name": "Junior Dev",
      "baseUrl": "https://newapi.tokenvault.vip/v1", "model": "gpt-5", "apiKeyEnv": "JUNIOR_API_KEY" },
    { "id": "openclaw", "type": "agent-remote", "mode": "link", "url": "https://claw.example.com", "roles": ["admin"] }
  ],
  "apps": [
    { "id": "newapi", "type": "app", "kind": "link", "name": "New API", "url": "https://newapi.tokenvault.vip" },
    { "id": "connect", "type": "app", "kind": "nango-connect", "name": "Bound Apps",
      "nangoUrl": "https://connect.tokenvault.vip", "connectUiUrl": "https://connect.tokenvault.vip", "apiUrl": "https://connect.tokenvault.vip" }
  ]
}
```

## Risks

- Header forgery if PAAS is reachable directly → opt-in flag + documented bind/firewall requirement.
- Cloud config URL down → last-good cache; a fetch error never empties the catalog.
- Long remote SSE streams → reuse the existing `isStreaming` guard; one prompt at a time per selection (same as today).
